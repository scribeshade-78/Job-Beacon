import type { SupabaseClient } from "@supabase/supabase-js";
import { decideSubmissionGrant, type ClaimContext, type Decision } from "./claimDecision.js";
import { evaluateEligibilityGates, type EligibilityGateOutcome } from "./eligibilityGate.js";

/**
 * The gatekeeper for extension-driven submission.
 *
 * THREE RULES, IN THIS ORDER, AND THE ORDER IS THE DESIGN:
 *
 *   1. THE ATTEMPT IS LOADED FROM THE DATABASE AND ITS OWNERSHIP IS VERIFIED. Nothing
 *      about the attempt - its status, its lease, whether it was approved - is taken from
 *      the request. A caller supplies an attempt id and a lease token; everything else is
 *      read. Without the ownership check one candidate could submit another's application
 *      by guessing a uuid.
 *
 *   2. THE GATES RUN BEFORE THE LEASE IS TOUCHED, via evaluateEligibilityGates - the same
 *      function the rest of the platform uses. NOT ONE GATE IS RE-IMPLEMENTED HERE, and
 *      that is the point: the 17 gates and the M7 weekly quota already live there, and a
 *      second copy would be a second answer to the same question. Running them first also
 *      means a refusal costs the candidate nothing and reports something useful ("the
 *      source was switched off"), rather than burning the lease and reporting "gone".
 *
 *   3. THE CONSUMPTION IS A SINGLE CONDITIONAL UPDATE. See consumeSubmission below.
 *
 * WHAT THIS MODULE CANNOT DO: it cannot fill a form, and it holds no token. It is the
 * second of the two trips, and it exists precisely so the first trip has no way to reach a
 * submission on its own.
 */

export interface AuthorizeSubmissionInput {
  candidateId: string;
  attemptId: string;
  /** The uuid minted when this attempt was leased. Proof the caller holds the lease. */
  leaseToken: string;
  now?: () => Date;
}

export interface AuthorizedSubmission {
  allowed: true;
  attemptId: string;
  vacancyId: string;
}

export interface RefusedSubmission {
  allowed: false;
  refusal: string;
  gate?: string;
  reasonCode?: string;
}

export type AuthorizeSubmissionResult = AuthorizedSubmission | RefusedSubmission;

interface AttemptRow {
  id: string;
  application_plan_id: string;
  status: string;
  lease_token: string | null;
  review_approved_at: string | null;
}

interface PlanRow {
  id: string;
  vacancy_id: string;
  candidate_id: string;
}

/**
 * The single-use consumption, and the only write this module makes.
 *
 * ONE UPDATE, WITH EVERY CONDITION IN ITS WHERE CLAUSE, and the row it returns is the
 * authorisation. The database decides atomically; there is no read-then-write window for
 * two callers to slip through.
 *
 *   lease_token = the caller's   -> proof it holds the lease it was granted
 *   status IN (pending, ...)     -> NOT ALREADY CONSUMED. This is what makes it single-use
 *                                   rather than merely conditional: the first call moves
 *                                   the status to 'submitting', so the second call matches
 *                                   no rows and receives nothing.
 *
 * ZERO ROWS IS THE REFUSAL. It covers every racing case at once - already submitted, lease
 * taken over after expiry, status changed under us - and none of them is distinguishable
 * from the others, which is correct: the caller's next move is the same in all of them.
 */
async function consumeSubmission(
  client: SupabaseClient,
  attemptId: string,
  leaseToken: string,
  now: Date,
): Promise<boolean> {
  const { data, error } = await client
    .from("application_attempts")
    .update({
      status: "submitting",
      // Back to the default as the human-paced lease is consumed: from here the row is in the
      // unreclaimable 'submitting' state, and leaving it marked 'extension' would keep a stale
      // marker on an attempt no executor may hold again. See 20261017120000.
      leased_by: "worker",
      submission_started_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", attemptId)
    .eq("lease_token", leaseToken)
    .in("status", ["pending", "pending_review"])
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data !== null;
}

export async function authorizeSubmission(
  client: SupabaseClient,
  input: AuthorizeSubmissionInput,
  /** Injectable for tests; defaults to the real gate evaluator. */
  loadGates: (client: SupabaseClient, ids: { candidateId: string; vacancyId: string }) => Promise<EligibilityGateOutcome> =
    evaluateEligibilityGates,
): Promise<AuthorizeSubmissionResult> {
  const now = input.now ?? (() => new Date());

  // 1. Load the attempt, then its plan, so ownership comes from rows rather than a claim.
  const { data: attemptData, error: attemptError } = await client
    .from("application_attempts")
    .select("id, application_plan_id, status, lease_token, review_approved_at")
    .eq("id", input.attemptId)
    .maybeSingle();

  if (attemptError) {
    throw attemptError;
  }

  const attempt = attemptData as AttemptRow | null;

  if (!attempt) {
    return { allowed: false, refusal: "NOT_FOUND" };
  }

  const { data: planData, error: planError } = await client
    .from("application_plans")
    .select("id, vacancy_id, candidate_id")
    .eq("id", attempt.application_plan_id)
    .maybeSingle();

  if (planError) {
    throw planError;
  }

  const plan = planData as PlanRow | null;

  // OWNERSHIP FIRST, before the gates and before any write. A mismatched candidate is
  // refused identically whether or not the attempt exists, so this cannot be used to probe
  // for other people's attempts.
  if (!plan || plan.candidate_id !== input.candidateId) {
    return { allowed: false, refusal: "NOT_FOUND" };
  }

  // 2. The gates, from the shared evaluator. Not one is re-implemented here.
  const outcome = await loadGates(client, {
    candidateId: input.candidateId,
    vacancyId: plan.vacancy_id,
  });

  // review_before_submit is read from the same place the review gate reads it. The
  // approval itself is the ATTEMPT's own record - review_approved_at - never a boolean
  // from the request, so a client cannot assert that it was approved.
  const { data: profileData, error: profileError } = await client
    .from("candidate_profiles")
    .select("review_before_submit")
    .eq("id", input.candidateId)
    .maybeSingle();

  if (profileError) {
    throw profileError;
  }

  const reviewBeforeSubmit = (profileData as { review_before_submit: boolean | null } | null)?.review_before_submit === true;

  const context: ClaimContext = {
    gates: outcome.gates,
    reviewBeforeSubmit,
    attemptStatus: attempt.status,
    // Derived from the row, not from the caller.
    candidateApproved: attempt.review_approved_at !== null,
    // The caller must present the lease token the attempt is actually leased under.
    holdsLease: attempt.lease_token !== null && attempt.lease_token === input.leaseToken,
  };

  const decision: Decision = decideSubmissionGrant(context);

  if (!decision.allowed) {
    return { allowed: false, refusal: decision.refusal, gate: decision.gate, reasonCode: decision.reasonCode };
  }

  // 3. Consume, atomically, last.
  const consumed = await consumeSubmission(client, attempt.id, input.leaseToken, now());

  if (!consumed) {
    // Every racing case lands here. By the time we got this far the gates passed and the
    // lease matched, so the only thing that can have changed is that someone else consumed
    // it first.
    return { allowed: false, refusal: "ALREADY_CONSUMED" };
  }

  return { allowed: true, attemptId: attempt.id, vacancyId: plan.vacancy_id };
}
