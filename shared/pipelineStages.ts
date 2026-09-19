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
 * stage by pipelineStageOf below, so the five categorized counts sum exactly
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
 *   In Progress  never submitted successfully — attempts pending, held for
 *                review (pending_review), leased, failed, cancelled, or none
 *                at all
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
export interface PipelineStageInput {
  attempts: ReadonlyArray<{ status: string }>;
  responseCategories: readonly string[];
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
  { id: "applied", label: "Applied" },
  { id: "interview", label: "Interview" },
  { id: "offer", label: "Offer" },
  { id: "rejection", label: "Rejection" },
] as const;

export type PipelineStageId = (typeof PIPELINE_STAGES)[number]["id"];

/** Every stage except the All aggregate — each application is exactly one of these. */
export type CategorizedPipelineStageId = Exclude<PipelineStageId, "all">;

/** Ordered strongest first. The first match wins. */
const RESPONSE_PRECEDENCE = ["offer", "rejection", "interview"] as const;

/** Mirrors PIPELINE_STAGES minus All, so the two cannot drift apart visually. */
export const CATEGORIZED_STAGE_IDS: readonly CategorizedPipelineStageId[] = [
  "in_progress",
  "applied",
  "interview",
  "offer",
  "rejection",
];

/**
 * The single stage an application belongs to. Total by construction: the final
 * branch catches everything, so no row can fall outside the bar and the counts
 * cannot leak.
 */
export function pipelineStageOf(application: PipelineStageInput): CategorizedPipelineStageId {
  for (const stage of RESPONSE_PRECEDENCE) {
    if (application.responseCategories.includes(stage)) {
      return stage;
    }
  }

  if (application.attempts.some((attempt) => attempt.status === "succeeded")) {
    return "applied";
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
 * One pass, one bucket per application. All is the list length and the five
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
