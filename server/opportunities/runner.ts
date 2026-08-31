import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalyzeFitDeps } from "./analyzeFit.js";
import { runOneFitAnalysisJob } from "./fitWorker.js";

/**
 * Response Intelligence Phase 2.1 — single-pass batch entrypoint: drains
 * fit_analysis_jobs by repeatedly calling runOneFitAnalysisJob until the
 * queue is empty or maxPerBatch is hit. Meant to be invoked once per
 * process (see cli.ts) and scheduled externally — no daemon loop, same
 * scope stance as the application and ingestion workers.
 */

const DEFAULT_MAX_PER_BATCH = 50;

export interface RunFitAnalysisBatchOptions {
  maxPerBatch?: number;
}

export interface RunFitAnalysisBatchResult {
  claimed: number;
  analyzed: number;
  capped: number;
  noJdText: number;
  failed: number;
  /** Set only if the claim RPC itself errored (infra-level), stopping the drain. */
  claimError?: string;
}

export async function runFitAnalysisBatch(
  client: SupabaseClient,
  deps: AnalyzeFitDeps,
  options: RunFitAnalysisBatchOptions = {},
): Promise<RunFitAnalysisBatchResult> {
  const maxPerBatch = options.maxPerBatch ?? DEFAULT_MAX_PER_BATCH;

  const result: RunFitAnalysisBatchResult = {
    claimed: 0,
    analyzed: 0,
    capped: 0,
    noJdText: 0,
    failed: 0,
  };

  while (result.claimed < maxPerBatch) {
    let job;
    try {
      job = await runOneFitAnalysisJob(client, deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[opportunities:fit] batch claim failed", { error: message });
      result.claimError = message;
      break;
    }

    if (!job.processed) {
      break;
    }

    result.claimed += 1;
    if (job.error) {
      result.failed += 1;
    } else {
      result.analyzed += 1;
      if (job.capped) {
        result.capped += 1;
      }
      if (job.jdTextAvailable === false) {
        result.noJdText += 1;
      }
    }
  }

  return result;
}
