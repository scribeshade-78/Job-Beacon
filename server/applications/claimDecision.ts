import type { EligibilityGates } from "./eligibilityGate.js";

/**
 * WHAT MAY HAPPEN TO AN ATTEMPT, DECIDED IN ONE PLACE.
 *
 * This is a PURE function on purpose. It is the part of the auto-apply engine that decides
 * whether a browser extension is authorised to fill a form and then to submit it, and the
 * consequences of getting it wrong are not recoverable: a submission an employer receives
 * cannot be recalled. Keeping the decision free of I/O is what makes every refusal path
 * testable, and the test enumerates EVERY gate rather than the happy path.
 *
 * TWO TRIPS, AND THE FIRST ONE CANNOT SUBMIT.
 *
 *   Trip 1 - decideFillClaim: the extension may populate a form. It receives no token and
 *   there is no field for one, so a compromised or buggy client cannot promote a fill into
 *   a submission by asking nicely. The candidate looks at what was filled.
 *
 *   Trip 2 - decideSubmissionGrant: only after the candidate approves, and only with a
 *   freshly re-evaluated set of gates. Nothing from trip 1 is trusted: not the gates, not
 *   the lease, not the fact that filling happened at all.
 *
 * REVIEW_BEFORE_SUBMIT IS A FLOOR, NOT A SWITCH. When it is on, the attempt sits in
 * pending_review and trip 2 requires explicit approval. When the candidate has waived it,
 * the attempt is pending and approval is implied by the request - but every gate still
 * runs, and gates are re-run at submission time in BOTH cases. A gate that passed at fill
 * time can be false minutes later: the quota can be spent, the source can be switched off,
 * the candidate can pause automation.
 */

/** Why a claim or a grant was refused. Stable codes, because the UI renders them. */
export type ClaimRefusal =
  | "GATE_FAILED"
  | "ALREADY_CLAIMED"
  | "NOTHING_TO_DO"
  | "NOT_APPROVED"
  | "LEASE_LOST";

export interface ClaimContext {
  gates: EligibilityGates;
  reviewBeforeSubmit: boolean;
  /** application_attempts.status, as a plain string so this module owns no enum. */
  attemptStatus: string;
  /** Trip 2 only: the candidate pressed Approve on THIS attempt. */
  candidateApproved?: boolean;
  /** Trip 2 only: the caller still holds the lease it was granted at fill time. */
  holdsLease?: boolean;
}

export type Decision =
  | { allowed: true }
  | { allowed: false; refusal: ClaimRefusal; gate?: string; reasonCode?: string };

/**
 * The gates that can refuse, in a FIXED order so a failure is deterministic.
 *
 * `plan_entitlement` is the M7 weekly quota. It is optional because application_plans rows
 * written before that gate existed have no such key, and an ABSENT optional gate means
 * "not evaluated", not "passed" - reading it as a pass would be inventing an answer, and
 * reading it as a failure would refuse every legacy row. Absent is simply not a refusal.
 */
const GATE_ORDER: Array<keyof EligibilityGates> = [
  "source_policy",
  "vacancy_trust",
  "automation_authorization",
  "candidate_exclusions",
  "idempotency",
  "role_match",
  "verified_facts",
  "application_support",
  "rate_and_abuse_controls",
  "dismissed",
  "preferred_qualifiers",
  "excluded_company",
  "excluded_industry",
  "work_mode",
  "salary",
  "location",
  "plan_entitlement",
];

/** The first gate that refuses, or null when none does. */
function firstFailingGate(gates: EligibilityGates): { gate: string; reasonCode?: string } | null {
  for (const name of GATE_ORDER) {
    const gate = gates[name];
    // Absent optional gate: not evaluated, therefore not a refusal.
    if (gate === undefined) {
      continue;
    }
    if (gate.status !== "pass") {
      return { gate: name, reasonCode: gate.reasonCode };
    }
  }
  return null;
}

/** Statuses that mean there is nothing left to claim. */
const SPENT_STATUSES = new Set(["succeeded", "submitting", "cancelled"]);

/** Trip 1: may the extension fill this form? Never returns a token. */
export function decideFillClaim(context: ClaimContext): Decision {
  const failing = firstFailingGate(context.gates);

  if (failing) {
    return { allowed: false, refusal: "GATE_FAILED", gate: failing.gate, reasonCode: failing.reasonCode };
  }

  // Checked AFTER the gates so a refusal reports the substantive reason: "the source was
  // switched off" is more useful to a candidate than "someone else has it".
  if (context.attemptStatus === "leased") {
    return { allowed: false, refusal: "ALREADY_CLAIMED" };
  }

  if (SPENT_STATUSES.has(context.attemptStatus)) {
    return { allowed: false, refusal: "NOTHING_TO_DO" };
  }

  // pending and pending_review are both claimable. A held attempt is exactly the one a
  // candidate needs filled in order to review it.
  return { allowed: true };
}

/** Trip 2: may this exact attempt be submitted, now, by this caller? */
export function decideSubmissionGrant(context: ClaimContext): Decision {
  // Re-run the gates FIRST. Everything below is about authorisation to act; a failed gate
  // means there is nothing to authorise, and reporting the gate is more useful than
  // reporting a lease problem caused by the refusal.
  const failing = firstFailingGate(context.gates);

  if (failing) {
    return { allowed: false, refusal: "GATE_FAILED", gate: failing.gate, reasonCode: failing.reasonCode };
  }

  if (context.holdsLease !== true) {
    return { allowed: false, refusal: "LEASE_LOST" };
  }

  if (context.reviewBeforeSubmit && context.candidateApproved !== true) {
    return { allowed: false, refusal: "NOT_APPROVED" };
  }

  const submittable = context.reviewBeforeSubmit
    ? context.attemptStatus === "pending_review"
    : context.attemptStatus === "pending" || context.attemptStatus === "pending_review";

  if (!submittable) {
    return { allowed: false, refusal: "NOTHING_TO_DO" };
  }

  return { allowed: true };
}
