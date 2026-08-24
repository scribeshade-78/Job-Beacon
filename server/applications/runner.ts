import type { SupabaseClient } from "@supabase/supabase-js";
import { planApplication } from "./applicationEngine.js";
import { VACANCY_TRUST_ELIGIBLE_STATUSES } from "./eligibilityGate.js";
import { runOneApplicationAttempt } from "./worker.js";

const DEFAULT_MAX_ATTEMPTS_PER_BATCH = 50;

export interface RunApplicationBatchOptions {
  /** Caps the attempt-drain loop so one batch can't run unbounded — mirrors "batch limit reached" from the spec. */
  maxAttemptsPerBatch?: number;
}

export interface PlanningFailure {
  candidateId: string;
  vacancyId: string;
  error: string;
}

export interface RunApplicationBatchResult {
  candidateIds: string[];
  vacancyIds: string[];
  plansEvaluated: number;
  plansEligible: number;
  planningFailures: PlanningFailure[];
  attemptsProcessed: number;
  /** Set only if the attempt-drain loop itself had to stop early on an infra-level error (see drainAttempts' doc comment). */
  attemptDrainError?: string;
}

interface CandidateIdRow {
  candidate_id: string;
}

/**
 * Candidates eligible for this batch: automation_authorizations.status ===
 * 'authorized' AND at least one candidate_selected_roles row (MP-R1).
 * Two-step query (authorized ids, then which of those have a role row)
 * mirrors the existing two-step style (evaluateVerifiedFacts,
 * resumeExtraction.ts's listExtractedFacts) rather than a single joined
 * query neither table's client-side helpers currently use.
 */
async function findActiveCandidateIds(client: SupabaseClient): Promise<string[]> {
  const { data: authRows, error: authError } = await client
    .from("automation_authorizations")
    .select("candidate_id")
    .eq("status", "authorized");

  if (authError) {
    throw authError;
  }

  const authorizedCandidateIds = ((authRows ?? []) as CandidateIdRow[]).map((row) => row.candidate_id);

  if (authorizedCandidateIds.length === 0) {
    return [];
  }

  const { data: roleRows, error: roleError } = await client
    .from("candidate_selected_roles")
    .select("candidate_id")
    .in("candidate_id", authorizedCandidateIds);

  if (roleError) {
    throw roleError;
  }

  return [...new Set(((roleRows ?? []) as CandidateIdRow[]).map((row) => row.candidate_id))];
}

/**
 * Vacancies this batch will attempt to plan against. Deliberately no
 * role-name pre-filter here (approved decision) — planApplication's own
 * role_match gate already does the real candidate<->vacancy role
 * comparison; duplicating that substring logic here would create a
 * second, driftable copy of the same rule. The tradeoff is real: this is
 * a full candidates x vacancies fan-out per batch, sized for current
 * pre-launch data volumes, not a scale-tested join.
 */
async function findVerifiedVacancyIds(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client
    .from("vacancies")
    .select("id")
    .in("trust_status", [...VACANCY_TRUST_ELIGIBLE_STATUSES]);

  if (error) {
    throw error;
  }

  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
}

/**
 * Plans every (candidate, vacancy) pair in this batch. Each pair is
 * isolated in its own try/catch — a thrown error here means an actual
 * infra/query failure (e.g. a missing vacancies row), not a normal
 * ineligible-gate outcome (planApplication already returns eligible:false
 * for that, it never throws for it) — so one bad pair must not stop the
 * rest of the batch from being planned. There's no dedicated DB evidence
 * table for planning-cycle failures (application_evidence is per-attempt
 * submission evidence, written inside runOneApplicationAttempt itself),
 * so this logs structured console.error output and returns the failures
 * for the caller to surface.
 */
async function planBatch(
  client: SupabaseClient,
  candidateIds: string[],
  vacancyIds: string[],
): Promise<{ plansEvaluated: number; plansEligible: number; planningFailures: PlanningFailure[] }> {
  let plansEvaluated = 0;
  let plansEligible = 0;
  const planningFailures: PlanningFailure[] = [];

  for (const candidateId of candidateIds) {
    for (const vacancyId of vacancyIds) {
      try {
        const result = await planApplication(client, { candidateId, vacancyId });
        plansEvaluated += 1;
        if (result.eligible) {
          plansEligible += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[applications:runner] planning failed", { candidateId, vacancyId, error: message });
        planningFailures.push({ candidateId, vacancyId, error: message });
      }
    }
  }

  return { plansEvaluated, plansEligible, planningFailures };
}

/**
 * Drains application_attempts by repeatedly calling runOneApplicationAttempt
 * until the queue is empty (processed:false) or maxAttemptsPerBatch is hit.
 * runOneApplicationAttempt already isolates per-attempt failures internally
 * (records evidence, sets 'failed'/'leased'/'cancelled', never throws for
 * them) — it only throws when the claim_application_attempt RPC call
 * itself errors, an infra-level failure with no specific attempt to
 * attribute it to. Retrying that in a tight loop would just re-fail
 * immediately, so this stops the drain for this batch rather than looping;
 * the next scheduled batch run picks back up.
 */
async function drainAttempts(
  client: SupabaseClient,
  maxAttemptsPerBatch: number,
): Promise<{ attemptsProcessed: number; attemptDrainError?: string }> {
  let attemptsProcessed = 0;

  while (attemptsProcessed < maxAttemptsPerBatch) {
    try {
      const result = await runOneApplicationAttempt(client);
      if (!result.processed) {
        break;
      }
      attemptsProcessed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[applications:runner] attempt drain failed", { error: message });
      return { attemptsProcessed, attemptDrainError: message };
    }
  }

  return { attemptsProcessed };
}

/**
 * MP-W1 single-pass batch entrypoint: find active candidates (authorized +
 * at least one selected role) x verified vacancies, plan every pair, then
 * drain whatever attempts planning created. Meant to be invoked once per
 * process (see cli.ts) and scheduled externally (cron) — no daemon loop or
 * signal handling here, per the approved MP-W1 scope (deferred to a
 * dedicated scheduling/deployment phase, same position R4.3 already
 * documented for the ingestion worker).
 */
export async function runApplicationBatch(
  client: SupabaseClient,
  options: RunApplicationBatchOptions = {},
): Promise<RunApplicationBatchResult> {
  const maxAttemptsPerBatch = options.maxAttemptsPerBatch ?? DEFAULT_MAX_ATTEMPTS_PER_BATCH;

  const candidateIds = await findActiveCandidateIds(client);
  const vacancyIds = await findVerifiedVacancyIds(client);

  const { plansEvaluated, plansEligible, planningFailures } = await planBatch(client, candidateIds, vacancyIds);
  const { attemptsProcessed, attemptDrainError } = await drainAttempts(client, maxAttemptsPerBatch);

  return {
    candidateIds,
    vacancyIds,
    plansEvaluated,
    plansEligible,
    planningFailures,
    attemptsProcessed,
    ...(attemptDrainError !== undefined ? { attemptDrainError } : {}),
  };
}
