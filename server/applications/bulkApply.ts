import type { SupabaseClient } from "@supabase/supabase-js";
import { planApplication } from "./applicationEngine.js";
import type { EligibilityGateOutcome } from "./eligibilityGate.js";

/**
 * Mini-Phase 6 — bulk enqueue for the Opportunities page's
 * "Apply to X loaded matches" button.
 *
 * GATES ARE NOT BYPASSED. This maps over the requested vacancies and calls
 * planApplication for each — the same single funnel the worker CLI and
 * /api/worker/run use — rather than inserting application_attempts rows
 * directly. Inserting them directly would have been the obvious reading of
 * "create a plan and a pending attempt", and it would have silently disabled
 * rate_and_abuse_controls (MAX_DAILY_APPLICATIONS_PER_CANDIDATE = 25 over a
 * rolling 24h), automation_authorization (consent the candidate may have
 * paused or stopped), verified_facts, role_match and application_support in
 * one click. The gates are the product's abuse and consent boundary, so the
 * bulk path goes through them like everything else.
 *
 * The honest consequence: with no adapter registered for any source
 * (adapters/registry.ts resolves every source_code to unsupportedAdapter),
 * application_support fails for every vacancy and this correctly enqueues
 * nothing. The result carries the per-vacancy gate outcomes so the UI can say
 * exactly why instead of looking broken.
 */

/** Upper bound on one request. The route rejects anything larger. */
export const MAX_BULK_APPLY_VACANCIES = 100;

export interface BlockingGate {
  gate: string;
  reasonCode: string | null;
}

export interface BulkApplyOutcome {
  vacancyId: string;
  status: "queued" | "blocked" | "error";
  /** Every gate that failed, in the gate's own declaration order. Empty when queued. */
  blockingGates: BlockingGate[];
  /** Set only for status "error" — an infrastructure failure, never a gate outcome. */
  error?: string;
}

export interface BulkApplyResult {
  requested: number;
  queued: number;
  blocked: number;
  errors: number;
  outcomes: BulkApplyOutcome[];
}

function blockingGatesOf(gateResults: EligibilityGateOutcome): BlockingGate[] {
  return Object.entries(gateResults.gates)
    .filter(([, result]) => result.status === "fail")
    .map(([gate, result]) => ({ gate, reasonCode: result.reasonCode ?? null }));
}

export interface BulkApplyInput {
  candidateId: string;
  vacancyIds: readonly string[];
}

/**
 * Error isolation matches runApplicationBatch's precedent: a thrown error is
 * an infrastructure/query failure (an ordinary ineligible-gate outcome never
 * throws), so it is recorded against that one vacancy and the batch continues
 * rather than losing every remaining plan to one bad row.
 */
export async function bulkApplyToVacancies(
  client: SupabaseClient,
  input: BulkApplyInput,
): Promise<BulkApplyResult> {
  // Deduplicated before counting, so a caller repeating an id cannot inflate
  // the requested total or plan the same vacancy twice in one request.
  const vacancyIds = [...new Set(input.vacancyIds)];

  const result: BulkApplyResult = {
    requested: vacancyIds.length,
    queued: 0,
    blocked: 0,
    errors: 0,
    outcomes: [],
  };

  for (const vacancyId of vacancyIds) {
    try {
      const plan = await planApplication(client, { candidateId: input.candidateId, vacancyId });

      // attemptCreated === false with eligible === true means an active attempt
      // already exists (createAttemptIfNoneActive reuses it). That is not a
      // failure — the work is already queued — so both cases count as queued.
      if (plan.eligible) {
        result.queued += 1;
        result.outcomes.push({ vacancyId, status: "queued", blockingGates: [] });
        continue;
      }

      result.blocked += 1;
      result.outcomes.push({
        vacancyId,
        status: "blocked",
        blockingGates: blockingGatesOf(plan.gateResults),
      });
    } catch (error) {
      result.errors += 1;
      result.outcomes.push({
        vacancyId,
        status: "error",
        blockingGates: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
