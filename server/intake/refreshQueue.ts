import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { runFitAnalysisBatch } from "../opportunities/runner.js";
import { runIntakeAcrossSources, type IntakeSourceSummary } from "./intake.js";
import { loadIntakeQueryContext } from "./queryContext.js";

/**
 * The candidate-scoped intake-refresh queue (Step 5 of the async transition).
 *
 * WHY THIS EXISTS. POST /api/intake/discover used to AWAIT the whole fan-out. That fan-out
 * is sequential by design (Jooble's free plan is a 500-request LIFETIME budget and every
 * page spends one), so its duration scales with the number of sources and their latency -
 * and a request that blocks is a request that some proxy, gateway or browser kills first.
 * The candidate is then told the fetch failed while it is still succeeding.
 *
 * WHY NOT REUSE ingestion_jobs. That queue is TARGET-scoped: a row names one employer board
 * and nothing else. An intake refresh is CANDIDATE-scoped - "fetch jobs matching MY
 * keywords, in MY markets" - so it has nowhere to put the candidate and would give one
 * queue two incompatible meanings. This mirrors fit_analysis_jobs, the existing
 * candidate-scoped lease queue, instead.
 *
 * THE PROFILE IS NOT COPIED INTO THE ROW. Only what the request itself knows is stored
 * (which sources, an explicit search, a row cap). Keywords, location and markets are read
 * from the candidate's CURRENT profile when the job runs, minutes later, so a refresh
 * reflects who they are now rather than who they were when they pressed the button.
 */

export interface IntakeRefreshRequest {
  /** Empty or absent means every registered intake source, matching the route's behaviour. */
  sourceCodes?: readonly string[];
  search?: string;
  limit?: number;
}

export interface EnqueueIntakeRefreshResult {
  enqueued: boolean;
  /** True when a pending or leased refresh already exists for this candidate. */
  alreadyRunning: boolean;
  jobId: string | null;
}

export interface IntakeRefreshQueryContext {
  keywords?: string;
  location?: string;
  country?: string;
  countries?: readonly string[];
}

export interface IntakeRefreshDeps {
  /** Injectable for tests; defaults to the real profile reader. */
  loadQueryContext?: (client: SupabaseClient, candidateId: string) => Promise<IntakeRefreshQueryContext>;
  runIntake?: typeof runIntakeAcrossSources;
  /**
   * The model client the post-refresh fit batch needs. Absent means "fetch only": the
   * new vacancies stay queued for the scheduled fit drain rather than being scored here.
   */
  openai?: Pick<OpenAI, "chat">;
  /** Injectable for tests; defaults to runFitAnalysisBatch. */
  runFit?: typeof runFitAnalysisBatch;
}

/** Postgres unique_violation. Raised by the partial index that allows one active refresh. */
const UNIQUE_VIOLATION = "23505";

/**
 * Queues one refresh for this candidate. Idempotent in the sense that matters: pressing the
 * button twice does not run two identical fan-outs, and the second press says so rather
 * than failing.
 */
export async function enqueueIntakeRefresh(
  client: SupabaseClient,
  candidateId: string,
  request: IntakeRefreshRequest = {},
): Promise<EnqueueIntakeRefreshResult> {
  const { data, error } = await client
    .from("intake_refresh_jobs")
    .insert({
      candidate_id: candidateId,
      source_codes: [...(request.sourceCodes ?? [])],
      search: request.search ?? null,
      row_limit: request.limit ?? null,
    })
    .select("id")
    .single();

  if (error) {
    // ALREADY RUNNING IS A RESULT, NOT A FAILURE. The partial unique index
    // (intake_refresh_jobs_active_per_candidate_idx) is what refuses a second row, and it
    // refuses it by raising this. Reporting it as an error would turn the normal double-tap
    // into a 500.
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return { enqueued: false, alreadyRunning: true, jobId: null };
    }

    throw error;
  }

  return { enqueued: true, alreadyRunning: false, jobId: (data?.id as string | undefined) ?? null };
}

export interface DrainIntakeRefreshOptions {
  /** Caps jobs claimed per call. Defaults to 3 - each one is a multi-source network fan-out. */
  maxJobs?: number;
  /**
   * Wall-clock budget, checked BEFORE each claim and never during one. A started fan-out
   * always finishes: interrupting a third-party request would spend a quota unit without
   * recording a result, which is the worst of both.
   */
  deadlineMs?: number;
  deps?: IntakeRefreshDeps;
  /** Injectable clock — tests only. */
  now?: () => Date;
}

export interface DrainIntakeRefreshResult {
  processed: number;
  stoppedOnDeadline: boolean;
}

/**
 * What a finished refresh stores. This is the summary the HTTP route used to return
 * synchronously, now durable so the monitor can render it minutes after the press.
 *
 * THE CLIENT'S describeDiscoveryResult READS EVERY FIELD HERE, the per-source list
 * included - attribution is a per-source legal obligation and cannot be collapsed to a
 * scalar, and newVacancyIds is what lets the list mark the rows that are actually new.
 */
export interface IntakeRefreshStoredResult {
  sources: IntakeSourceSummary[];
  received: number;
  ingested: number;
  created: number;
  updated: number;
  newVacancyIds: string[];
  skippedByAdapter: number;
  trustStatusCounts: Record<string, number>;
  durationMs: number;
  failedSources: number;
  fitAnalyzed: number;
  fitPending: number;
  fitStoppedOnDeadline: boolean;
  fitError: string | null;
}

const DEFAULT_MAX_JOBS = 3;
const DEFAULT_DEADLINE_MS = 4 * 60_000;

/**
 * Bounds for the post-refresh fit batch, moved here from the route that used to run it.
 *
 * Each analysis is two model calls, so a count bound alone is not enough - five analyses
 * at roughly ten seconds each is close to a minute of wall clock, which is why the batch
 * also carries a wall-clock ceiling and stops STARTING work when it expires.
 */
const MAX_FIT_ANALYSES_PER_REFRESH = 5;
const FIT_ANALYSIS_BUDGET_MS = 45_000;

/**
 * Claims and processes queued refreshes, one at a time, bounded by maxJobs and a deadline.
 *
 * A FAILED REFRESH IS RECORDED, NOT THROWN. One candidate's source being down must not end
 * the tick and leave every other queued refresh unclaimed; runIntakeAcrossSources already
 * isolates individual sources, so reaching the catch here means the whole fan-out failed.
 */
export async function drainIntakeRefreshJobs(
  client: SupabaseClient,
  options: DrainIntakeRefreshOptions = {},
): Promise<DrainIntakeRefreshResult> {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  const now = options.now ?? (() => new Date());
  const deps = options.deps ?? {};
  const loadContext = deps.loadQueryContext ?? loadIntakeQueryContext;
  const runIntake = deps.runIntake ?? runIntakeAcrossSources;
  const deadline =
    options.deadlineMs === undefined ? null : now().getTime() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);

  let processed = 0;

  for (let claimed = 0; claimed < maxJobs; claimed += 1) {
    if (deadline !== null && now().getTime() >= deadline) {
      return { processed, stoppedOnDeadline: true };
    }

    const { data, error } = await client.rpc("claim_intake_refresh_job");

    if (error) {
      console.error("[intake:refresh] claim failed", { error: error.message });
      return { processed, stoppedOnDeadline: false };
    }

    const job = (data ?? [])[0] as
      | { id: string; candidate_id: string; source_codes: string[] | null; search: string | null; row_limit: number | null }
      | undefined;

    if (!job) {
      return { processed, stoppedOnDeadline: false };
    }

    const sourceCodes = job.source_codes ?? [];

    try {
      const context = await loadContext(client, job.candidate_id);

      const result = await runIntake(
        client,
        {
          // An empty stored array means "every registered source", which is exactly what
          // undefined means to the fan-out - not an empty allow-list that matches nothing.
          sourceCodes: sourceCodes.length > 0 ? sourceCodes : undefined,
          search: job.search ?? undefined,
          limit: job.row_limit ?? undefined,
          keywords: context.keywords,
          location: context.location,
          country: context.country,
          countries: context.countries as string[] | undefined,
        },
        {},
      );

      // SCORING HAPPENS HERE NOW, immediately after the pull, so the vacancies a
      // refresh just created rank on their own instead of waiting behind the scheduled
      // fit drain's FIFO backlog.
      const fit = await runPostRefreshFit(client, result.newVacancyIds, deps, now, deadline);

      await client
        .from("intake_refresh_jobs")
        .update({
          status: "done",
          // THE FULL SUMMARY the monitor renders, not only the counts.
          result: {
            sources: result.sources,
            received: result.received,
            ingested: result.ingested,
            created: result.created,
            updated: result.updated,
            newVacancyIds: result.newVacancyIds,
            skippedByAdapter: result.skippedByAdapter,
            trustStatusCounts: result.trustStatusCounts,
            durationMs: result.durationMs,
            failedSources: result.failedSources,
            fitAnalyzed: fit.analyzed,
            fitPending: Math.max(result.newVacancyIds.length - fit.analyzed, 0),
            fitStoppedOnDeadline: fit.stoppedOnDeadline,
            fitError: fit.error ?? null,
          } satisfies IntakeRefreshStoredResult,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[intake:refresh] job failed", { jobId: job.id, error: message });

      await client
        .from("intake_refresh_jobs")
        .update({ status: "failed", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", job.id);
    }

    processed += 1;
  }

  return { processed, stoppedOnDeadline: false };
}

/**
 * Scores the vacancies a refresh just created, immediately after the pull.
 *
 * THIS MOVED HERE FROM THE HTTP ROUTE. It used to run inline after the fan-out; when the
 * fan-out became background work, its scoring step had to become background work too, or
 * a candidate's new jobs would carry a NULL priority score and sort below every scored
 * row - the original "fetch produced jobs I cannot find" defect in a new costume.
 *
 * BEST-EFFORT, EXACTLY AS ON THE REQUEST PATH. The vacancies are already ingested and
 * visible, and the scheduled fit drain will pick them up, so a scoring failure must not
 * turn a successful refresh into a failed job.
 */
async function runPostRefreshFit(
  client: SupabaseClient,
  newVacancyIds: readonly string[],
  deps: IntakeRefreshDeps,
  now: () => Date,
  deadline: number | null,
): Promise<{ analyzed: number; failed: number; stoppedOnDeadline: boolean; error?: string }> {
  if (newVacancyIds.length === 0) {
    return { analyzed: 0, failed: 0, stoppedOnDeadline: false };
  }

  const openai = deps.openai;
  if (!openai) {
    // No model client means fetch-only. The vacancies stay queued for the scheduled fit
    // drain - the honest state, not "scored zero" as if an attempt had been made.
    return { analyzed: 0, failed: 0, stoppedOnDeadline: false };
  }

  // NEVER OUTLIVE THE DRAIN'S OWN DEADLINE. A job whose lease expires while still running
  // becomes claimable again and a second worker duplicates the fan-out; bounding the fit
  // step to what remains is what keeps one slow model call from causing that.
  const remaining = deadline === null ? FIT_ANALYSIS_BUDGET_MS : deadline - now().getTime();
  if (remaining <= 0) {
    return { analyzed: 0, failed: 0, stoppedOnDeadline: true };
  }

  const runFit = deps.runFit ?? runFitAnalysisBatch;

  try {
    const fit = await runFit(
      client,
      { openai },
      {
        vacancyIds: newVacancyIds,
        maxPerBatch: MAX_FIT_ANALYSES_PER_REFRESH,
        deadlineMs: Math.min(FIT_ANALYSIS_BUDGET_MS, remaining),
      },
    );

    return {
      analyzed: fit.analyzed,
      failed: fit.failed,
      stoppedOnDeadline: fit.stoppedOnDeadline === true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[intake:refresh] fit analysis failed", { error: message });
    return { analyzed: 0, failed: 0, stoppedOnDeadline: false, error: message };
  }
}

export type IntakeRefreshJobStatus = "idle" | "pending" | "leased" | "done" | "failed";

export interface IntakeRefreshStatus {
  status: IntakeRefreshJobStatus;
  /** True while the queue still owns the work, so a poller knows to keep asking. */
  running: boolean;
  /** The stored summary, present only once the job is done. */
  result: IntakeRefreshStoredResult | null;
  /** Why the job failed, present only when it did. */
  lastError: string | null;
  updatedAt: string | null;
}

/**
 * The candidate's LATEST refresh, for the monitor half of trigger-and-monitor.
 *
 * SCOPED TO ONE CANDIDATE BY THE CALLER, never by the client: the route passes the JWT
 * subject, so one candidate cannot read another's refresh by guessing an id. There is no
 * id parameter for exactly that reason.
 *
 * ONE ROW, NOT A LIST. The UI needs to render a state, and the newest row is the press
 * the candidate is waiting on; showing them history would invite them to read an old
 * result as the answer to the button they just pressed.
 */
export async function readLatestIntakeRefresh(
  client: SupabaseClient,
  candidateId: string,
): Promise<IntakeRefreshStatus> {
  const { data, error } = await client
    .from("intake_refresh_jobs")
    .select("status, result, last_error, updated_at")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return { status: "idle", running: false, result: null, lastError: null, updatedAt: null };
  }

  const row = data as {
    status: "pending" | "leased" | "done" | "failed";
    result: IntakeRefreshStoredResult | null;
    last_error: string | null;
    updated_at: string | null;
  };

  return {
    status: row.status,
    running: row.status === "pending" || row.status === "leased",
    // A result only means something for a finished job; a leased row's null must not be
    // mistaken for "finished with nothing".
    result: row.status === "done" ? (row.result ?? null) : null,
    lastError: row.status === "failed" ? (row.last_error ?? null) : null,
    updatedAt: row.updated_at ?? null,
  };
}

