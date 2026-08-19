import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchMcaCompanyByCin, McaRecordNotFoundError, type McaCredentials } from "./mcaRegistry.js";
import { recordAndUpsertLegalEntity } from "./registryIngest.js";

export interface RunOneRegistryLookupJobResult {
  processed: boolean;
  jobId?: string;
  outcome?: "done" | "failed";
  error?: string;
}

interface ClaimedJob {
  id: string;
  company_id: string;
  cin: string;
  attempts: number;
  max_attempts: number;
}

/**
 * Claims and executes exactly one company_registry_lookup_jobs row.
 * Structurally mirrors runOneApplicationAttempt/runOneIngestionJob — same
 * claim-RPC-then-try/catch shape, same exponential-backoff-vs-dead-letter
 * decision — reusing the proven pattern instead of inventing a third one.
 * Doesn't run a persistent process itself; a caller loops on this or
 * schedules it periodically.
 *
 * McaRecordNotFoundError is terminal, not retried: a CIN that doesn't
 * exist won't start existing on retry, so this dead-letters immediately
 * rather than consuming retry attempts on a lookup that can never
 * succeed. Every other failure (rate limiting, network errors, an
 * unexpected response shape) takes the generic backoff-then-dead-letter
 * path, same Math.min(2 ** attempts, 60)-minute formula already used in
 * both sibling workers.
 */
export async function runOneRegistryLookupJob(
  client: SupabaseClient,
  credentials: McaCredentials,
): Promise<RunOneRegistryLookupJobResult> {
  const { data: jobs, error: claimError } = await client.rpc("claim_company_registry_lookup_job");

  if (claimError) {
    throw claimError;
  }

  const job = jobs?.[0] as ClaimedJob | undefined;

  if (!job) {
    return { processed: false };
  }

  try {
    const record = await fetchMcaCompanyByCin(job.cin, credentials);
    await recordAndUpsertLegalEntity(client, job.company_id, record);

    await client
      .from("company_registry_lookup_jobs")
      .update({ status: "done", updated_at: new Date().toISOString() })
      .eq("id", job.id);

    return { processed: true, jobId: job.id, outcome: "done" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof McaRecordNotFoundError) {
      await client
        .from("company_registry_lookup_jobs")
        .update({ status: "failed", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", job.id);

      return { processed: true, jobId: job.id, outcome: "failed", error: message };
    }

    const exhausted = job.attempts >= job.max_attempts;

    if (exhausted) {
      // Dead-letter: claim_company_registry_lookup_job's WHERE clause
      // never matches 'failed', so this is terminal — visible via this
      // row for manual review.
      await client
        .from("company_registry_lookup_jobs")
        .update({ status: "failed", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", job.id);
    } else {
      // Retry with backoff: staying 'leased' with a future leased_until
      // is what actually delays the retry (setting status back to
      // 'pending' would make it immediately reclaimable — same reasoning
      // as the sibling workers' own comments).
      const backoffMinutes = Math.min(2 ** job.attempts, 60);
      await client
        .from("company_registry_lookup_jobs")
        .update({
          status: "leased",
          leased_until: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
    }

    return { processed: true, jobId: job.id, outcome: "failed", error: message };
  }
}
