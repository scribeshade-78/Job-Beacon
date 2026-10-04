/**
 * The pipeline stage rule — shared by the candidate UI
 * (client/src/lib/pipelineStages.ts re-exports this) and the MCP server
 * (server/mcp/tools.ts).
 *
 * It lives in shared/ rather than client/src/lib/ because
 * tsconfig.server.json includes only ["server", "shared"]: the MCP server
 * cannot import a client module, and a server-side copy of the precedence
 * rule would be a second, driftable definition of product behaviour — the
 * exact failure mode this codebase's "one rule, no driftable copy" comments
 * repeatedly warn against.
 *
 * The stages are MUTUALLY EXCLUSIVE: every application is assigned exactly one
 * stage by pipelineStageOf below, so the six categorized counts sum exactly
 * to All.
 *
 * "Verification" and "Assessment" remain dropped rather than approximated: no
 * status, column or classification category in this schema represents either
 * one, and a chip that can never match is worse than an absent one.
 *
 * WHAT EACH STAGE MEANS
 *
 *   Offer        an offer response
 *   Rejection    a rejection response
 *   Interview    an interview response
 *   Applied      submitted successfully, with no response yet
 *   In Progress  never submitted successfully AND still eligible — attempts
 *                pending, held for review (pending_review), leased, failed,
 *                cancelled, or none at all
 *   Ineligible   the eligibility gates refused the plan, so no attempt was ever
 *                created. gate_results.eligible is false; nothing was sent, so
 *                this must not read as work in progress.
 *
 * RESPONSE PRECEDENCE is Offer > Rejection > Interview, per explicit product
 * direction. An application can legitimately hold several response categories
 * at once — the common real case is interviewed-then-rejected, which carries
 * both an interview and a rejection — and the terminal, later outcome is the
 * truthful thing to show. Ranking an interviewed-and-rejected application
 * under "Interview" would report a stage the candidate has already left.
 *
 * "Rejection" NEVER maps to application_attempts.status = failed. That value
 * means the submission worker could not send the application at all (retries
 * exhausted, portal error) — it says nothing about the employer, so such a row
 * is "In Progress", not rejected. Rendering it as a rejection would tell a
 * candidate they were turned down for a job that was never applied to.
 */

/**
 * Structural, not imported from the client: anything carrying an attempt list
 * and a response-category list satisfies it, so both the browser's
 * ApplicationSummary and the MCP server's own row shape can use these
 * functions without shared/ depending on either.
 */
/**
 * One attempt, as the classification needs to see it.
 *
 * acceptedEvidence IS THE POINT OF THIS SHAPE. "The worker wrote
 * status='succeeded'" and "we hold a trustworthy persisted confirmation for
 * this attempt" are different facts, and only the second means the application
 * was actually submitted. It is OPTIONAL so a caller that cannot load evidence
 * degrades to NOT Applied rather than to a false Applied: absent, unreadable or
 * unloaded evidence must never establish acceptance.
 */
export interface PipelineAttemptInput {
  status: string;
  /** True only for a trustworthy confirmation persisted against THIS attempt. */
  acceptedEvidence?: boolean;
}

export interface PipelineStageInput {
  attempts: ReadonlyArray<PipelineAttemptInput>;
  responseCategories: readonly string[];
  /**
   * gate_results.eligible: whether the eligibility gates let this plan queue.
   * Required rather than optional so a new caller cannot silently inherit the
   * old "everything without a submission is in progress" behaviour.
   */
  eligible: boolean;
}

/**
 * Ordered CHRONOLOGICALLY, which is the order the bar renders in: All is the
 * aggregate, In Progress is the entry state before anything has been
 * submitted, and the rest ascend through Applied -> Interview -> Offer.
 * Rejection sits last as the terminal outcome rather than as a rung on the
 * ladder — it is where a pipeline ends, not a stage it advances to.
 */
export const PIPELINE_STAGES = [
  { id: "all", label: "All" },
  { id: "in_progress", label: "In Progress" },
  { id: "ineligible", label: "Not eligible" },
  { id: "reconciliation_pending", label: "Reconciliation pending" },
  { id: "needs_verification", label: "Submission needs verification" },
  { id: "applied", label: "Applied" },
  { id: "interview", label: "Interview" },
  { id: "offer", label: "Offer" },
  { id: "rejection", label: "Rejection" },
] as const;

export type PipelineStageId = (typeof PIPELINE_STAGES)[number]["id"];

/** Every stage except the All aggregate — each application is exactly one of these. */
export type CategorizedPipelineStageId = Exclude<PipelineStageId, "all">;

/**
 * The evidence_type the submission path writes ONLY after an adapter returns a
 * confirmed acceptance. Nothing else in this repository writes it, and
 * authenticated holds no INSERT grant on application_evidence, so a candidate
 * cannot produce one — that write permission, not a payload shape, is the
 * provenance this classification trusts.
 */
export const ACCEPTANCE_EVIDENCE_TYPE = "submission_confirmation";

/**
 * Whether one evidence row is a trustworthy acceptance confirmation.
 *
 * DELIBERATELY NOT A FIELD CHECKLIST. The adapter contract is
 * { evidenceType, payload } with an adapter-chosen payload (see
 * ApplicationSubmissionResult), so requiring a specific receipt field would
 * invent a contract that does not exist. What is checked instead: the type is
 * the one only the service-role submission path writes, the payload is a
 * non-empty object (a null, array or empty payload is malformed and proves
 * nothing), and the row must belong to the attempt being classified — the
 * caller supplies rows for ONE attempt, so cross-attempt evidence cannot leak in.
 */
export function isTrustworthyAcceptanceEvidence(
  row: { evidence_type?: unknown; payload?: unknown } | null | undefined,
): boolean {
  if (row === null || row === undefined || row.evidence_type !== ACCEPTANCE_EVIDENCE_TYPE) {
    return false;
  }

  const payload = row.payload;

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }

  const keys = Object.keys(payload as Record<string, unknown>);

  if (keys.length === 0) {
    return false;
  }

  // THE WRAPPER MUST NOT MANUFACTURE ACCEPTANCE. The submission path stores the
  // adapter's own type beside its payload as provenance, so a payload whose ONLY
  // key is that provenance field means the adapter itself returned nothing
  // confirming — an empty inner result wearing a non-empty outer object.
  return !keys.every((key) => key === "adapterEvidenceType");
}

/** Ordered strongest first. The first match wins. */
const RESPONSE_PRECEDENCE = ["offer", "rejection", "interview"] as const;

/** Mirrors PIPELINE_STAGES minus All, so the two cannot drift apart visually. */
export const CATEGORIZED_STAGE_IDS: readonly CategorizedPipelineStageId[] = [
  "in_progress",
  "ineligible",
  "reconciliation_pending",
  "needs_verification",
  "applied",
  "interview",
  "offer",
  "rejection",
];

/**
 * The single stage an application belongs to. Total by construction: the
 * eligibility branch and the final in_progress branch partition everything not
 * otherwise classified, so no row can fall outside the bar and the counts cannot
 * leak.
 *
 * ELIGIBILITY IS CHECKED AFTER A SUBMISSION, NOT BEFORE. A response or a
 * succeeded attempt is evidence something real happened and outranks a later
 * re-evaluation that flipped gate_results to ineligible; "Applied" is the
 * truthful stage for a plan that was actually sent. Only a plan with no
 * submission and eligible = false is "Ineligible" — which is exactly the
 * population that used to be mislabelled "In Progress".
 */
export function pipelineStageOf(application: PipelineStageInput): CategorizedPipelineStageId {
  for (const stage of RESPONSE_PRECEDENCE) {
    if (application.responseCategories.includes(stage)) {
      return stage;
    }
  }

  // THE BOUNDARY STATES, checked before the ordinary branches.
  //
  // 'submitting' means an external attempt may have begun. With a stored
  // confirmation it is only awaiting finalization; without one the outcome is
  // unknown. Neither is Applied, and neither may be reported as "never
  // submitted" — both are things a human may need to check.
  const submitting = application.attempts.filter((attempt) => attempt.status === "submitting");

  if (submitting.some((attempt) => attempt.acceptedEvidence === true)) {
    return "reconciliation_pending";
  }

  if (submitting.length > 0) {
    return "needs_verification";
  }

  // A 'succeeded' attempt is Applied ONLY with a trustworthy persisted
  // confirmation for that same attempt. Bare success — the shape the old
  // unchecked evidence write produced — is an unverified acceptance claim.
  const succeeded = application.attempts.filter((attempt) => attempt.status === "succeeded");

  if (succeeded.length > 0) {
    return succeeded.some((attempt) => attempt.acceptedEvidence === true)
      ? "applied"
      : "needs_verification";
  }

  if (!application.eligible) {
    return "ineligible";
  }

  return "in_progress";
}

export function matchesPipelineStage(application: PipelineStageInput, stage: PipelineStageId): boolean {
  return stage === "all" || pipelineStageOf(application) === stage;
}

export function filterByPipelineStage<T extends PipelineStageInput>(
  applications: readonly T[],
  stage: PipelineStageId,
): T[] {
  return applications.filter((application) => matchesPipelineStage(application, stage));
}

/**
 * One pass, one bucket per application. All is the list length and the six
 * categorized counts sum to it exactly — asserted in the tests, because a
 * partition that silently stops partitioning is the whole failure mode this
 * rule exists to prevent.
 */
export function countByPipelineStage<T extends PipelineStageInput>(
  applications: readonly T[],
): Record<PipelineStageId, number> {
  const counts: Record<PipelineStageId, number> = {
    all: applications.length,
    in_progress: 0,
    ineligible: 0,
    reconciliation_pending: 0,
    needs_verification: 0,
    applied: 0,
    interview: 0,
    offer: 0,
    rejection: 0,
  };

  for (const application of applications) {
    counts[pipelineStageOf(application)] += 1;
  }

  return counts;
}
