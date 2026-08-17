import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ACTIVE_ATTEMPT_STATUSES,
  evaluateEligibilityGates,
  type EligibilityGateOutcome,
} from "./eligibilityGate.js";

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
 * Idempotent plan creation. application_plans' own
 * UNIQUE(candidate_id, vacancy_id) constraint (R4.1) is the actual
 * guarantee; this looks up an existing plan first to avoid re-running
 * gate evaluation needlessly, and — since two concurrent callers can
 * both pass that lookup before either inserts — falls back to re-reading
 * the row on a 23505 unique-violation instead of treating the race as a
 * failure. Same idempotent-on-duplicate pattern as
 * automationAuthorization.ts's authorize() and reports.ts's precedent.
 * gate_results is frozen at creation time (same "evidence snapshot
 * frozen" precedent as vacancy_evidence/moderation_cases) — a repeat call
 * for the same pair reuses the original evaluation rather than
 * re-running it.
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
    return existing as ApplicationPlanRow;
  }

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

  const { data: inserted, error: insertError } = await client
    .from("application_attempts")
    .insert({ application_plan_id: applicationPlanId, status: "pending" })
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

  const attempt = await createAttemptIfNoneActive(client, plan.id);

  return {
    applicationPlanId: plan.id,
    eligible: true,
    gateResults,
    applicationAttemptId: attempt.applicationAttemptId,
    attemptCreated: attempt.created,
  };
}
