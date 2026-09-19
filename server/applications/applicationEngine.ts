import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ACTIVE_ATTEMPT_STATUSES,
  evaluateEligibilityGates,
  type EligibilityGateOutcome,
} from "./eligibilityGate.js";
import { initialAttemptStatusFor, readReviewBeforeSubmit } from "./attemptReview.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export interface PlanApplicationInput {
  candidateId: string;
  vacancyId: string;
}

/**
 * application_plans (R4.1) has no status column — "blocked" vs. eligible
 * is derived from gateResults.eligible, the same "derive, don't
 * duplicate" discipline moderation_cases already established (that table
 * has no status column either; resolution is derived from whether a
 * moderation_decisions row exists). Adding a redundant status column here
 * would create a second, driftable source of truth for a fact
 * gate_results already carries.
 */
export interface PlanApplicationResult {
  applicationPlanId: string;
  eligible: boolean;
  gateResults: EligibilityGateOutcome;
  applicationAttemptId?: string;
  attemptCreated: boolean;
}

interface ApplicationPlanRow {
  id: string;
  gate_results: EligibilityGateOutcome;
}

/**
 * Re-runs the gates for a plan whose STORED verdict is "not eligible", writes
 * the fresh outcome back, and returns the updated row.
 *
 * WHY AN INELIGIBLE VERDICT IS NOT FROZEN. gate_results is otherwise an
 * immutable snapshot, the same "evidence captured, then frozen" precedent as
 * vacancy_evidence/moderation_cases — but an ineligible verdict is not
 * evidence about the vacancy, it is a decision about the state of the system
 * at one moment: which adapters are registered, what a source policy allows,
 * whether the candidate had confirmed facts yet. Every one of those inputs
 * changes over time. Freezing a "no" permanently left the system unable to
 * recover from its own starting state — with no adapter registered, one visit
 * to the Opportunities page marked every vacancy it touched ineligible
 * forever, and those pairs could never be queued even after an adapter
 * shipped.
 *
 * An ELIGIBLE verdict is still reused untouched. Re-running the gates there
 * would spend queries re-deriving a decision that has already been acted on
 * (an attempt may exist), and flipping it after the fact is not this
 * function's business.
 *
 * The previous verdict is overwritten rather than versioned:
 * application_plans has no history column or table, and adding one is a schema
 * change this fix does not require. That does mean superseded reason codes are
 * not retained anywhere — if an audit trail of gate verdicts is wanted later,
 * it belongs in its own append-only table, not in a column this function has
 * to mutate.
 */
async function reevaluateIneligiblePlan(
  client: SupabaseClient,
  plan: ApplicationPlanRow,
  candidateId: string,
  vacancyId: string,
): Promise<ApplicationPlanRow | null> {
  const gateResults = await evaluateEligibilityGates(client, { candidateId, vacancyId });

  const { data: updated, error: updateError } = await client
    .from("application_plans")
    .update({ gate_results: gateResults })
    .eq("id", plan.id)
    .select("id, gate_results")
    .maybeSingle();

  if (updateError) {
    throw updateError;
  }

  return (updated as ApplicationPlanRow | null) ?? null;
}

/** The create half, split out so a plan that vanished mid-flight can fall back to it. */
async function insertPlanWithFreshEvaluation(
  client: SupabaseClient,
  candidateId: string,
  vacancyId: string,
): Promise<ApplicationPlanRow> {
  const gateResults = await evaluateEligibilityGates(client, { candidateId, vacancyId });

  const { data: inserted, error: insertError } = await client
    .from("application_plans")
    .insert({ candidate_id: candidateId, vacancy_id: vacancyId, gate_results: gateResults })
    .select("id, gate_results")
    .single();

  if (insertError) {
    if ((insertError as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
      const { data: afterRace, error: raceSelectError } = await client
        .from("application_plans")
        .select("id, gate_results")
        .eq("candidate_id", candidateId)
        .eq("vacancy_id", vacancyId)
        .maybeSingle();

      if (raceSelectError) {
        throw raceSelectError;
      }
      if (!afterRace) {
        throw new Error("application_plans insert conflicted (23505) but no row was found on retry.");
      }
      return afterRace as ApplicationPlanRow;
    }
    throw insertError;
  }
  if (!inserted) {
    throw new Error("Failed to insert application_plans row — no row returned.");
  }

  return inserted as ApplicationPlanRow;
}

/**
 * Idempotent plan creation. application_plans' own
 * UNIQUE(candidate_id, vacancy_id) constraint (R4.1) is the actual
 * guarantee; this looks up an existing plan first to avoid re-running
 * gate evaluation needlessly, and — since two concurrent callers can
 * both pass that lookup before either inserts — falls back to re-reading
 * the row on a 23505 unique-violation instead of treating the race as a
 * failure. Same idempotent-on-duplicate pattern as
 * automationAuthorization.ts's authorize() and reports.ts's precedent.
 *
 * An existing plan is reused only when its stored verdict is ELIGIBLE. A
 * stored "not eligible" is re-evaluated — see reevaluateIneligiblePlan for why
 * that verdict specifically is not frozen.
 */
async function getOrCreatePlan(
  client: SupabaseClient,
  candidateId: string,
  vacancyId: string,
): Promise<ApplicationPlanRow> {
  const { data: existing, error: selectError } = await client
    .from("application_plans")
    .select("id, gate_results")
    .eq("candidate_id", candidateId)
    .eq("vacancy_id", vacancyId)
    .maybeSingle();

  if (selectError) {
    throw selectError;
  }

  if (existing) {
    const plan = existing as ApplicationPlanRow;

    if (plan.gate_results.eligible) {
      return plan;
    }

    const reevaluated = await reevaluateIneligiblePlan(client, plan, candidateId, vacancyId);

    if (reevaluated) {
      return reevaluated;
    }

    // The row disappeared between the read and the update. Deleting a plan is
    // not an operation this codebase performs, so this is defensive only —
    // fall through and create it fresh rather than returning a stale row.
  }

  return insertPlanWithFreshEvaluation(client, candidateId, vacancyId);
}

interface AttemptCreationResult {
  applicationAttemptId: string;
  created: boolean;
}

/**
 * Mirrors evaluateEligibilityGates' own idempotency gate, but decides a
 * different question: that gate governs whether a *plan* should be
 * created at all; this governs whether a *new attempt* should be created
 * against an already-eligible, already-existing plan (e.g. a retry after
 * a prior attempt failed). Reuses ACTIVE_ATTEMPT_STATUSES rather than
 * redefining which statuses count as "already active work."
 */
async function createAttemptIfNoneActive(
  client: SupabaseClient,
  applicationPlanId: string,
  candidateId: string,
): Promise<AttemptCreationResult> {
  const { data: attempts, error: attemptsError } = await client
    .from("application_attempts")
    .select("id, status")
    .eq("application_plan_id", applicationPlanId);

  if (attemptsError) {
    throw attemptsError;
  }

  const blocking = ((attempts ?? []) as Array<{ id: string; status: string }>).find((attempt) =>
    ACTIVE_ATTEMPT_STATUSES.has(attempt.status),
  );

  if (blocking) {
    return { applicationAttemptId: blocking.id, created: false };
  }

  // Task U: a new attempt starts held when the candidate wants to review
  // before submission. Read here, at the moment the attempt is created, rather
  // than checked later by the worker: the preference is a decision about
  // whether this application may be dispatched unattended, and it should be
  // the value in force when the application was queued. Re-reading it at claim
  // time would let a candidate who turns review OFF while an attempt is held
  // silently release everything already in their queue.
  //
  // The consequence the other way is real and deliberate: turning review OFF
  // does not release attempts already held. Those still need approving, which
  // is the conservative direction — the alternative dispatches work the
  // candidate was told they would see first.
  const reviewBeforeSubmit = await readReviewBeforeSubmit(client, candidateId);

  const { data: inserted, error: insertError } = await client
    .from("application_attempts")
    .insert({
      application_plan_id: applicationPlanId,
      status: initialAttemptStatusFor(reviewBeforeSubmit),
    })
    .select("id")
    .single();

  if (insertError) {
    throw insertError;
  }
  if (!inserted) {
    throw new Error("Failed to insert application_attempts row — no row returned.");
  }

  return { applicationAttemptId: (inserted as { id: string }).id, created: true };
}

/**
 * The R4.2/R4.3 planning entry point: evaluate (or reuse) a candidate +
 * vacancy's eligibility plan, and — only when eligible — ensure exactly
 * one active attempt exists for it. With 4 of 7 gates (role_match,
 * verified_facts, application_support, rate_and_abuse_controls)
 * permanently hard-failing today, `eligible` can never be true yet, so
 * no application_attempts row is created by real callers in this phase —
 * matching the approved R4 sequencing decision.
 */
export async function planApplication(
  client: SupabaseClient,
  input: PlanApplicationInput,
): Promise<PlanApplicationResult> {
  const plan = await getOrCreatePlan(client, input.candidateId, input.vacancyId);
  const gateResults = plan.gate_results;

  if (!gateResults.eligible) {
    return { applicationPlanId: plan.id, eligible: false, gateResults, attemptCreated: false };
  }

  const attempt = await createAttemptIfNoneActive(client, plan.id, input.candidateId);

  return {
    applicationPlanId: plan.id,
    eligible: true,
    gateResults,
    applicationAttemptId: attempt.applicationAttemptId,
    attemptCreated: attempt.created,
  };
}
