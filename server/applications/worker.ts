import type { SupabaseClient } from "@supabase/supabase-js";
import { submitApplicationAttempt } from "./submissionAdapter.js";

export interface RunOneAttemptResult {
  processed: boolean;
  applicationAttemptId?: string;
  outcome?: "succeeded" | "failed";
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
 * submitApplicationAttempt always throws today (no channel adapter is
 * implemented yet — PRD §16.2), so in practice every real call currently
 * takes the catch branch and records a 'failed'/retry outcome. The
 * success branch exists and is evidence-tested so the recording logic is
 * proven correct ahead of the first real adapter landing, not exercised
 * by a fake happy path in production.
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
    const result = await submitApplicationAttempt({
      applicationAttemptId: attempt.id,
      applicationPlanId: attempt.application_plan_id,
    });

    await client.from("application_evidence").insert({
      application_attempt_id: attempt.id,
      evidence_type: result.evidenceType,
      payload: result.payload,
    });

    await client
      .from("application_attempts")
      .update({ status: "succeeded", updated_at: new Date().toISOString() })
      .eq("id", attempt.id);

    return { processed: true, applicationAttemptId: attempt.id, outcome: "succeeded" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await client.from("application_evidence").insert({
      application_attempt_id: attempt.id,
      evidence_type: "submission_error",
      payload: { message },
    });

    const exhausted = attempt.attempts >= attempt.max_attempts;

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
      const backoffMinutes = Math.min(2 ** attempt.attempts, 60);
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
