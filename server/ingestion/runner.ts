import type { SupabaseClient } from "@supabase/supabase-js";
import { runOneIngestionJob } from "./worker.js";

/**
 * Candidate-triggerable ingestion batch (POST /api/opportunities/refresh,
 * the "Fetch latest jobs" button on the Opportunities page).
 *
 * The other workers in this repo are driven by an external scheduler; this
 * one is driven by a signed-in candidate, which changes the threat model in
 * one specific way that the rest of this file exists to contain.
 *
 * QUOTA SAFETY IS THE WHOLE DESIGN CONSTRAINT. Jooble's free REST plan is a
 * LIFETIME total of 500 requests per key — not monthly, not refillable —
 * and one paginated fetch is one request (see docs/JOOBLE_INTEGRATION.md
 * §1.3). A button any candidate can press is therefore a button that can
 * permanently destroy the account's remaining allowance, so:
 *
 *   1. Per-target cooldown. A target whose most recent run (success OR
 *      error) is inside minIntervalMinutes is not re-enqueued at all. This
 *      is the real quota guard; the HTTP-level rate limit in server/index.ts
 *      only bounds request volume.
 *   2. At most one queued job per target per call, and a target that
 *      already has a pending/leased job is left alone rather than stacked.
 *   3. maxJobs caps how much a single call can drain.
 *
 * The cooldown is deliberately checked against source_health_events rather
 * than ingestion_jobs: the job row is marked 'done' immediately after a
 * fetch, so it records that a fetch happened but not when the last one
 * actually ran, and it carries no history across the freshness sweep.
 */

const DEFAULT_MAX_JOBS = 10;
const DEFAULT_MIN_INTERVAL_MINUTES = 15;

export interface RunIngestionBatchOptions {
  /** Caps how many queued jobs one call drains. Defaults to 10. */
  maxJobs?: number;
  /** Per-target cooldown in minutes. Defaults to 15. */
  minIntervalMinutes?: number;
  /** Injectable clock — tests only. */
  now?: () => Date;
}

export interface IngestionTargetOutcome {
  sourceCode: string;
  targetKey: string;
  status: "fetched" | "skipped_recent" | "skipped_queued" | "failed";
  vacanciesFetched: number;
  /** Present when status is skipped_recent and the last run errored. */
  lastError?: string;
}

export interface RunIngestionBatchResult {
  targets: IngestionTargetOutcome[];
  vacanciesFetched: number;
  failed: number;
  skippedRecent: number;
  skippedQueued: number;
}

interface VacancySourceRow {
  id: string;
  source_code: string;
  target_key: string;
}

interface HealthRow {
  vacancy_source_id: string | null;
  status: string;
  vacancies_fetched: number;
  error_message: string | null;
  run_at: string;
}

export async function runIngestionBatch(
  client: SupabaseClient,
  options: RunIngestionBatchOptions = {},
): Promise<RunIngestionBatchResult> {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  const minIntervalMinutes = options.minIntervalMinutes ?? DEFAULT_MIN_INTERVAL_MINUTES;
  const now = (options.now ?? (() => new Date()))();

  const result: RunIngestionBatchResult = {
    targets: [],
    vacanciesFetched: 0,
    failed: 0,
    skippedRecent: 0,
    skippedQueued: 0,
  };

  // Only enabled targets. A disabled row is a deliberate operator decision to
  // stop polling that target, and a candidate pressing a button must not
  // override it.
  const { data: sourceRows, error: sourceError } = await client
    .from("vacancy_sources")
    .select("id, source_code, target_key")
    .eq("enabled", true);

  if (sourceError) {
    throw sourceError;
  }

  const targets = (sourceRows ?? []) as VacancySourceRow[];

  if (targets.length === 0) {
    return result;
  }

  const cooldownStart = new Date(now.getTime() - minIntervalMinutes * 60_000).toISOString();

  const enqueued: VacancySourceRow[] = [];

  for (const target of targets) {
    const { data: healthRows, error: healthError } = await client
      .from("source_health_events")
      .select("vacancy_source_id, status, vacancies_fetched, error_message, run_at")
      .eq("vacancy_source_id", target.id)
      .gte("run_at", cooldownStart)
      .order("run_at", { ascending: false })
      .limit(1);

    if (healthError) {
      throw healthError;
    }

    const recent = (healthRows ?? [])[0] as HealthRow | undefined;

    if (recent) {
      const outcome: IngestionTargetOutcome = {
        sourceCode: target.source_code,
        targetKey: target.target_key,
        status: "skipped_recent",
        vacanciesFetched: 0,
      };
      if (recent.status === "error" && recent.error_message) {
        outcome.lastError = recent.error_message;
      }
      result.targets.push(outcome);
      result.skippedRecent += 1;
      continue;
    }

    // A target with a live job is already being (or about to be) fetched —
    // stacking a second job would spend a second request for the same data.
    const { data: pendingJobs, error: pendingError } = await client
      .from("ingestion_jobs")
      .select("id")
      .eq("vacancy_source_id", target.id)
      .in("status", ["pending", "leased"])
      .limit(1);

    if (pendingError) {
      throw pendingError;
    }

    if ((pendingJobs ?? []).length > 0) {
      result.targets.push({
        sourceCode: target.source_code,
        targetKey: target.target_key,
        status: "skipped_queued",
        vacanciesFetched: 0,
      });
      result.skippedQueued += 1;
      continue;
    }

    enqueued.push(target);
  }

  if (enqueued.length === 0) {
    return result;
  }

  const { error: insertError } = await client.from("ingestion_jobs").insert(
    enqueued.map((target) => ({
      source_code: target.source_code,
      vacancy_source_id: target.id,
    })),
  );

  if (insertError) {
    throw insertError;
  }

  const batchStart = now.toISOString();

  for (let processed = 0; processed < maxJobs; processed += 1) {
    let job;
    try {
      job = await runOneIngestionJob(client);
    } catch (error) {
      // An infra-level claim failure (the RPC itself), not a per-target
      // outcome — there is no source to attribute it to. Stop draining
      // rather than looping against a broken queue, matching the
      // attempt-drain loop in server/applications/runner.ts.
      console.error("[ingestion:runner] claim failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }

    if (!job.processed) {
      break;
    }
  }

  // Attribute outcomes from the evidence the worker itself wrote, rather
  // than from parse position: runOneIngestionJob returns only
  // { processed, vacanciesFetched, error? } with no target identity, and
  // widening that return shape would break every existing assertion in
  // worker.test.ts for no benefit here.
  const { data: written, error: writtenError } = await client
    .from("source_health_events")
    .select("vacancy_source_id, status, vacancies_fetched, error_message, run_at")
    .gte("run_at", batchStart);

  if (writtenError) {
    throw writtenError;
  }

  const byTargetId = new Map<string, HealthRow>();
  for (const row of (written ?? []) as HealthRow[]) {
    if (row.vacancy_source_id && !byTargetId.has(row.vacancy_source_id)) {
      byTargetId.set(row.vacancy_source_id, row);
    }
  }

  for (const target of enqueued) {
    const row = byTargetId.get(target.id);

    if (!row) {
      // The job was enqueued but never ran (maxJobs reached, or the drain
      // stopped early). Report it honestly as unfetched rather than
      // claiming success — the job is still queued and the next call
      // (or the external scheduler) will pick it up.
      result.targets.push({
        sourceCode: target.source_code,
        targetKey: target.target_key,
        status: "skipped_queued",
        vacanciesFetched: 0,
      });
      result.skippedQueued += 1;
      continue;
    }

    if (row.status === "success") {
      result.targets.push({
        sourceCode: target.source_code,
        targetKey: target.target_key,
        status: "fetched",
        vacanciesFetched: row.vacancies_fetched,
      });
      result.vacanciesFetched += row.vacancies_fetched;
    } else {
      result.targets.push({
        sourceCode: target.source_code,
        targetKey: target.target_key,
        status: "failed",
        vacanciesFetched: 0,
        lastError: row.error_message ?? "Fetch failed.",
      });
      result.failed += 1;
    }
  }

  return result;
}
