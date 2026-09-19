import type { SupabaseClient } from "@supabase/supabase-js";
import { AtsSubmissionError } from "./adapters/errors.js";
import { createActionRequiredEvent } from "./actionRequired.js";
import {
  ActionRequiredSubmissionError,
  AuthorizationWithdrawnError,
  submitApplicationAttempt,
} from "./submissionAdapter.js";

export interface RunOneAttemptResult {
  processed: boolean;
  applicationAttemptId?: string;
  outcome?: "succeeded" | "failed" | "action_required" | "cancelled";
  error?: string;
}

interface ClaimedAttempt {
  id: string;
  application_plan_id: string;
  attempts: number;
  max_attempts: number;
}

/**
 * Claims and executes exactly one application_attempts row. Structurally
 * mirrors runOneIngestionJob (server/ingestion/worker.ts) — same claim-
 * RPC-then-try/catch shape, same exponential-backoff-vs-dead-letter
 * decision — reusing the proven pattern instead of inventing a second one
 * for this queue. Like that function, this doesn't run a persistent
 * process itself; a caller loops on this or schedules it periodically.
 *
 * submitApplicationAttempt (R7-M2) resolves a real per-source adapter, but
 * every source_code still resolves to unsupportedAdapter today (see
 * server/applications/adapters/registry.ts — no real per-source case
 * exists yet), which throws a plain Error. So in practice every real call
 * currently takes the generic catch branch below and records a
 * 'failed'/retry outcome, never the action_required one — no adapter
 * exists yet that could throw ActionRequiredSubmissionError instead. The
 * success, action_required, and cancelled (R7-M4) branches all exist and
 * are evidence-tested so their recording logic is proven correct ahead of
 * the first real adapter landing, not exercised by a fake happy path in
 * production.
 */
export async function runOneApplicationAttempt(client: SupabaseClient): Promise<RunOneAttemptResult> {
  const { data: attempts, error: claimError } = await client.rpc("claim_application_attempt");

  if (claimError) {
    throw claimError;
  }

  const attempt = attempts?.[0] as ClaimedAttempt | undefined;

  if (!attempt) {
    return { processed: false };
  }

  try {
    const result = await submitApplicationAttempt(client, {
      applicationAttemptId: attempt.id,
      applicationPlanId: attempt.application_plan_id,
    });

    await client.from("application_evidence").insert({
      application_attempt_id: attempt.id,
      evidence_type: result.evidenceType,
      payload: result.payload,
    });

    // succeeded_at is written HERE, on the transition, and nowhere else. It is
    // the timestamp the anti-ghosting detector measures from, and it exists
    // because updated_at cannot serve: that column means "last modified" and
    // moves for unrelated writes (generating a cover letter touches the row).
    // A seven-day clock keyed on a column that other code rewrites would reset
    // silently and the application would never be flagged.
    const succeededAt = new Date().toISOString();

    await client
      .from("application_attempts")
      .update({ status: "succeeded", succeeded_at: succeededAt, updated_at: succeededAt })
      .eq("id", attempt.id);

    return { processed: true, applicationAttemptId: attempt.id, outcome: "succeeded" };
  } catch (error) {
    if (error instanceof AuthorizationWithdrawnError) {
      // R7-M4: no application_evidence is written — nothing happened at
      // the adapter/portal level to have evidence about, this is purely
      // an internal authorization-gate decision. attempts is deliberately
      // left untouched (no compensating decrement): claim_application_attempt
      // already incremented it for this claim, and undoing that would be
      // a new kind of mutation with no precedent elsewhere in this
      // codebase. The common case — a candidate paused/stopped before
      // this claim happened at all — never reaches here in the first
      // place, because the same migration's cancellation sweep cancels
      // those rows before they're ever leased, so attempts is never
      // incremented for them to begin with.
      await client
        .from("application_attempts")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", attempt.id);

      return { processed: true, applicationAttemptId: attempt.id, outcome: "cancelled" };
    }

    if (error instanceof ActionRequiredSubmissionError) {
      await client.from("application_evidence").insert({
        application_attempt_id: attempt.id,
        evidence_type: "action_required",
        payload: { exceptionType: error.exceptionType, ...error.payload },
      });

      await createActionRequiredEvent(client, {
        applicationAttemptId: attempt.id,
        exceptionType: error.exceptionType,
        payload: error.payload,
        expiresAt: error.expiresAt,
      });

      return { processed: true, applicationAttemptId: attempt.id, outcome: "action_required" };
    }

    const message = error instanceof Error ? error.message : String(error);

    // Task H3, PRD §16.2 "handles validation/rate limits". A classified ATS
    // failure carries whether retrying could possibly help; anything else is an
    // unclassified error and is treated as retryable, which is the pre-H3
    // behaviour and the safe default.
    const atsError = error instanceof AtsSubmissionError ? error : null;
    const retryable = atsError ? atsError.retryable : true;

    await client.from("application_evidence").insert({
      application_attempt_id: attempt.id,
      evidence_type: "submission_error",
      payload: {
        message,
        ...(atsError
          ? {
              reasonCode: atsError.reasonCode,
              httpStatus: atsError.status,
              retryable: atsError.retryable,
              retryAfterSeconds: atsError.retryAfterSeconds,
            }
          : {}),
      },
    });

    // A validation rejection is terminal on the FIRST attempt, not after
    // max_attempts. The employer's form refused what we sent and will refuse it
    // again; retrying four times by exponential backoff burns that employer's
    // API budget and delays telling the candidate their application needs
    // attention. This is the "validation" half of §16.2.
    const exhausted = attempt.attempts >= attempt.max_attempts || !retryable;

    if (exhausted) {
      // Dead-letter: claim_application_attempt's WHERE clause never
      // matches 'failed', so this is terminal — visible via
      // application_evidence and this row for manual review.
      await client
        .from("application_attempts")
        .update({ status: "failed", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", attempt.id);
    } else {
      // Retry with backoff: setting status back to 'pending' would make
      // it immediately reclaimable (claim_application_attempt's WHERE
      // doesn't check leased_until for 'pending' rows) — staying
      // 'leased' with a future leased_until is what actually delays the
      // retry. Same backoff formula as runOneIngestionJob.
      // The provider's Retry-After wins when it is longer than our own backoff —
      // it is the party that knows when it will accept requests again. Ignoring
      // it would mean hammering a rate-limited endpoint on a schedule we chose
      // rather than the one we were asked to keep.
      const exponentialMinutes = Math.min(2 ** attempt.attempts, 60);
      const providerMinutes = atsError?.retryAfterSeconds != null ? atsError.retryAfterSeconds / 60 : 0;
      const backoffMinutes = Math.max(exponentialMinutes, providerMinutes);
      await client
        .from("application_attempts")
        .update({
          status: "leased",
          leased_until: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", attempt.id);
    }

    return { processed: true, applicationAttemptId: attempt.id, outcome: "failed", error: message };
  }
}
