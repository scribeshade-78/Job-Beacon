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
  /**
   * Restrict the batch to these source codes — the scheduled pull passes the keyless
   * public APIs so the unattended path never spends a credentialed source's quota.
   *
   * OMITTED means every enabled target; an EXPLICITLY EMPTY list means NONE. The empty
   * case is deliberately the opposite of the intake fan-out's, where an empty list means
   * "no preference". This parameter is a GUARD: a caller that computed an empty
   * allow-list must enqueue nothing, because treating it as "all" would silently put
   * Jooble's lifetime 500-request allowance back on the scheduled path — the exact
   * outcome the filter exists to prevent.
   */
  sourceCodes?: readonly string[];
  /** Injectable clock — tests only. */
  now?: () => Date;
}

export interface IngestionTargetOutcome {
  sourceCode: string;
  targetKey: string;
  /**
   * "queued" means this call put the target INTO the queue and did not wait for it.
   * It is the only status the HTTP path can now produce, because the HTTP path no
   * longer drains.
   */
  status: "queued" | "fetched" | "skipped_recent" | "skipped_queued" | "failed";
  vacanciesFetched: number;
  /** Present when status is skipped_recent and the last run errored. */
  lastError?: string;
}

export interface EnqueueIngestionBatchResult {
  targets: IngestionTargetOutcome[];
  /**
   * Targets this call put INTO the queue. Deliberately distinct from skippedQueued,
   * which is targets already in it — a caller reporting "started 3 refreshes" must not
   * be counting work somebody else queued.
   */
  enqueued: number;
  skippedRecent: number;
  skippedQueued: number;
}

export interface RunIngestionBatchResult extends EnqueueIngestionBatchResult {
  vacanciesFetched: number;
  failed: number;
}

export interface DrainIngestionJobsOptions {
  /** Caps how many queued jobs one call claims. Defaults to 10. */
  maxJobs?: number;
  /**
   * Wall-clock budget, checked BEFORE each claim. This is the real bound: maxJobs counts
   * JOBS, and a single job is a whole board — a 726-posting board took 392s in
   * production. Without a deadline, "drain up to 10 jobs" is unbounded in the dimension
   * that actually matters.
   */
  deadlineMs?: number;
  /** Injectable clock — tests only. */
  now?: () => Date;
}

export interface DrainIngestionJobsResult {
  processed: number;
  stoppedOnDeadline: boolean;
}

export interface IngestionQueueStatus {
  pending: number;
  leased: number;
  /** True while anything is queued or in flight — the condition a "refreshing" UI waits on. */
  running: boolean;
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

interface EnqueueInternals {
  result: EnqueueIngestionBatchResult;
  /** Rows this call queued, in the order they were queued. */
  enqueuedTargets: VacancySourceRow[];
  /** Set only when something was queued — the attribution window's lower bound. */
  batchStart: string | null;
}

/**
 * THE ENQUEUE HALF, ON ITS OWN.
 *
 * This is everything runIngestionBatch used to do before its drain loop, factored out so
 * the HTTP route can queue work and return immediately. The drain is what costs minutes,
 * and a request that blocks for minutes is a request that times out somewhere between the
 * browser and this process — while the work itself succeeded, so the candidate sees a
 * failure and the system sees a success.
 *
 * All the quota protection lives here rather than in the drain: the per-target cooldown
 * and the one-live-job-per-target check are what stand between a candidate-pressable
 * button and Jooble's lifetime 500-request allowance. Moving the drain off the request
 * path must not move those with it.
 */
async function enqueueInternal(
  client: SupabaseClient,
  options: RunIngestionBatchOptions,
): Promise<EnqueueInternals> {
  const minIntervalMinutes = options.minIntervalMinutes ?? DEFAULT_MIN_INTERVAL_MINUTES;
  const now = (options.now ?? (() => new Date()))();

  const result: EnqueueIngestionBatchResult = {
    targets: [],
    enqueued: 0,
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

  const allTargets = (sourceRows ?? []) as VacancySourceRow[];

  // THE SOURCE FILTER, APPLIED BEFORE ANY PER-TARGET WORK. Filtering here rather than in
  // the query means an excluded target is never cooldown-checked or pending-checked at
  // all, and it makes the empty case explicit instead of depending on how PostgREST
  // renders an empty IN list. undefined is the ONLY value that means "every enabled target".
  let targets: VacancySourceRow[];
  if (options.sourceCodes === undefined) {
    targets = allTargets;
  } else {
    const allowed = new Set(options.sourceCodes);
    targets = allTargets.filter((target) => allowed.has(target.source_code));
  }

  if (targets.length === 0) {
    return { result, enqueuedTargets: [], batchStart: null };
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
    return { result, enqueuedTargets: [], batchStart: null };
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

  // A queued target is REPORTED as queued, not as fetched. Nothing has been fetched yet.
  for (const target of enqueued) {
    result.targets.push({
      sourceCode: target.source_code,
      targetKey: target.target_key,
      status: "queued",
      vacanciesFetched: 0,
    });
  }
  result.enqueued = enqueued.length;

  return { result, enqueuedTargets: enqueued, batchStart: now.toISOString() };
}

/**
 * Queues discovery work for every enabled target that is eligible, and returns without
 * waiting for any of it. The counterpart half of runIngestionBatch; see enqueueInternal.
 */
export async function enqueueIngestionBatch(
  client: SupabaseClient,
  options: RunIngestionBatchOptions = {},
): Promise<EnqueueIngestionBatchResult> {
  return (await enqueueInternal(client, options)).result;
}

/**
 * Claims and processes queued jobs, bounded by maxJobs and by a wall-clock deadline.
 *
 * WHY A DEADLINE IS NOT OPTIONAL FOR A BACKGROUND CALLER. maxJobs bounds TARGETS, not
 * POSTINGS: one job is one board, and boards range from 10 postings (~8s) to 726 (~392s).
 * A caller that wants to run inside a scheduler tick has to say how long it is willing to
 * spend, or the tick overruns whatever cadence it was put on.
 */
export async function drainIngestionJobs(
  client: SupabaseClient,
  options: DrainIngestionJobsOptions = {},
): Promise<DrainIngestionJobsResult> {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  const now = options.now ?? (() => new Date());
  const deadline = options.deadlineMs === undefined ? null : now().getTime() + options.deadlineMs;

  let processed = 0;

  for (let claimed = 0; claimed < maxJobs; claimed += 1) {
    if (deadline !== null && now().getTime() >= deadline) {
      return { processed, stoppedOnDeadline: true };
    }

    let job;
    try {
      job = await runOneIngestionJob(client);
    } catch (error) {
      // An infra-level claim failure (the RPC itself), not a per-target outcome — there is
      // no source to attribute it to. Stop draining rather than looping against a broken
      // queue, matching the attempt-drain loop in server/applications/runner.ts.
      console.error("[ingestion:runner] claim failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { processed, stoppedOnDeadline: false };
    }

    if (!job.processed) {
      return { processed, stoppedOnDeadline: false };
    }

    processed += 1;
  }

  return { processed, stoppedOnDeadline: false };
}

/**
 * How much work is queued or in flight, for the UI that triggered it.
 *
 * The 202 tells a candidate their request was accepted; without this they have no way to
 * learn whether it finished, failed, or is still going. Deliberately two COUNT queries
 * rather than a paged read of the rows: the caller wants to render a state, not a list.
 */
export async function readIngestionQueueStatus(
  client: SupabaseClient,
): Promise<IngestionQueueStatus> {
  const countWhere = async (status: "pending" | "leased"): Promise<number> => {
    const { count, error } = await client
      .from("ingestion_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", status);
    if (error) throw error;
    return count ?? 0;
  };

  const pending = await countWhere("pending");
  const leased = await countWhere("leased");

  return { pending, leased, running: pending > 0 || leased > 0 };
}

/**
 * Enqueue AND drain, in one call. Kept because the admin worker task and the external
 * scheduler trigger both want "do the whole thing now"; the candidate-facing HTTP route
 * uses enqueueIngestionBatch instead and lets the scheduler do the draining.
 */
export async function runIngestionBatch(
  client: SupabaseClient,
  options: RunIngestionBatchOptions = {},
): Promise<RunIngestionBatchResult> {
  const internals = await enqueueInternal(client, options);
  const result: RunIngestionBatchResult = {
    ...internals.result,
    // The enqueue phase records every queued target so the 202 body can name them. Here
    // they are DROPPED, because the attribution loop below replaces each one with what
    // actually happened to it — keeping both would report every target twice, once as
    // "queued" and once as its outcome.
    targets: internals.result.targets.filter((target) => target.status !== "queued"),
    vacanciesFetched: 0,
    failed: 0,
  };

  if (internals.enqueuedTargets.length === 0) {
    return result;
  }

  const enqueued = internals.enqueuedTargets;
  const batchStart = internals.batchStart!;
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;

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
