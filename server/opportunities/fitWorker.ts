import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeFit, type AnalyzeFitDeps } from "./analyzeFit.js";

/**
 * Response Intelligence Phase 2.1 — claims and processes exactly one
 * fit_analysis_jobs row. Returns `{ processed: false }` when the queue is
 * empty; callers loop on this to drain the queue (see runner.ts). Retry /
 * dead-letter logic is copied from server/ingestion/worker.ts. Never
 * throws for a per-job failure — only the claim RPC itself throwing
 * propagates (an infra-level error with no job to attribute it to).
 */

export interface RunOneFitJobResult {
  processed: boolean;
  jobId?: string;
  capped?: boolean;
  jdTextAvailable?: boolean;
  error?: string;
}

interface FitJobRow {
  id: string;
  candidate_id: string;
  vacancy_id: string;
  attempts: number;
  max_attempts: number;
}

export async function runOneFitAnalysisJob(
  client: SupabaseClient,
  deps: AnalyzeFitDeps,
): Promise<RunOneFitJobResult> {
  const { data: jobs, error: claimError } = await client.rpc("claim_fit_analysis_job");

  if (claimError) {
    throw claimError;
  }

  const job = jobs?.[0] as FitJobRow | undefined;

  if (!job) {
    return { processed: false };
  }

  try {
    const row = await analyzeFit(client, deps, {
      candidateId: job.candidate_id,
      vacancyId: job.vacancy_id,
    });

    const { error: upsertError } = await client
      .from("fit_analyses")
      .upsert({ ...row, analyzed_at: new Date().toISOString() }, { onConflict: "candidate_id,vacancy_id" });

    if (upsertError) {
      throw upsertError;
    }

    await client
      .from("fit_analysis_jobs")
      .update({ status: "done", last_error: null, updated_at: new Date().toISOString() })
      .eq("id", job.id);

    return {
      processed: true,
      jobId: job.id,
      capped: row.eligibility_capped,
      jdTextAvailable: row.jd_text_available,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[opportunities:fit] job failed", { jobId: job.id, error: message });

    const exhausted = job.attempts >= job.max_attempts;

    if (exhausted) {
      // Dead-letter: claim_fit_analysis_job's WHERE never matches 'failed',
      // so this is terminal — visible via this row for manual review.
      await client
        .from("fit_analysis_jobs")
        .update({ status: "failed", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", job.id);
    } else {
      // Retry with backoff: staying 'leased' with a future leased_until is
      // what delays the retry (a 'pending' row would be immediately
      // reclaimable).
      const backoffMinutes = Math.min(2 ** job.attempts, 60);
      await client
        .from("fit_analysis_jobs")
        .update({
          status: "leased",
          leased_until: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
    }

    return { processed: true, jobId: job.id, error: message };
  }
}
