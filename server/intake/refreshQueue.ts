import type { SupabaseClient } from "@supabase/supabase-js";
import { runIntakeAcrossSources } from "./intake.js";
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

const DEFAULT_MAX_JOBS = 3;
const DEFAULT_DEADLINE_MS = 4 * 60_000;

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

      await client
        .from("intake_refresh_jobs")
        .update({
          status: "done",
          // The summary the route used to return synchronously, kept so the UI can report
          // what a finished refresh actually found rather than only that it stopped.
          result: {
            sources: result.sources,
            received: result.received,
            ingested: result.ingested,
            created: result.created,
            updated: result.updated,
          },
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
