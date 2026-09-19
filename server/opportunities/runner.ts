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
  /**
   * Restricts the batch to these vacancies, via the targeted claim RPC. Omitted,
   * the batch drains the queue oldest-first as the scheduled worker does.
   */
  vacancyIds?: readonly string[];
  /**
   * Stops STARTING new analyses once this many milliseconds have elapsed.
   *
   * A count bound alone is not enough for a request-scoped batch: each analysis
   * makes two model calls, so "at most 5" can still mean well over a minute of
   * wall clock and an HTTP request nobody is holding open for. An in-flight
   * analysis is never interrupted — this only prevents beginning another — so
   * the honest description is "does not start work after the budget", and the
   * caller reports how many were left queued.
   */
  deadlineMs?: number;
  /** Injectable clock, for testing the deadline without waiting for it. */
  now?: () => number;
}

export interface RunFitAnalysisBatchResult {
  claimed: number;
  analyzed: number;
  capped: number;
  noJdText: number;
  failed: number;
  /** Set only if the claim RPC itself errored (infra-level), stopping the drain. */
  claimError?: string;
  /** True when the batch stopped because its time budget ran out, not because the queue emptied. */
  stoppedOnDeadline?: boolean;
}

export async function runFitAnalysisBatch(
  client: SupabaseClient,
  deps: AnalyzeFitDeps,
  options: RunFitAnalysisBatchOptions = {},
): Promise<RunFitAnalysisBatchResult> {
  const maxPerBatch = options.maxPerBatch ?? DEFAULT_MAX_PER_BATCH;
  const now = options.now ?? (() => Date.now());
  const deadline = options.deadlineMs === undefined ? Number.POSITIVE_INFINITY : now() + options.deadlineMs;

  const result: RunFitAnalysisBatchResult = {
    claimed: 0,
    analyzed: 0,
    capped: 0,
    noJdText: 0,
    failed: 0,
  };

  while (result.claimed < maxPerBatch) {
    // Checked before each claim, never mid-analysis: stopping a model call
    // already in flight is not something this loop can do, and pretending
    // otherwise would make the budget a lie.
    if (now() >= deadline) {
      result.stoppedOnDeadline = true;
      break;
    }

    let job;
    try {
      job = await runOneFitAnalysisJob(client, deps, { vacancyIds: options.vacancyIds });
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
