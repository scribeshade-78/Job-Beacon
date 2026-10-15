import { readEnvInt } from "../config/envInt.js";
import { runRankingRefresh, type RankingRefreshClient, type RankingRefreshResult } from "./rankingRefresh.js";

/**
 * BATCH C — the SCHEDULED refresh workflow, driven by the existing scheduler daemon
 * (server/schedulerTasks.ts); no new daemon, queue or pg-boss.
 *
 * RANKING REFRESH is DB-only over each candidate's own rows. It enumerates candidates
 * whose ranking is not current (service-role RPC) and runs the SAME runRankingRefresh the
 * manual route uses, bounded per candidate and per tick. It needs no automation consent:
 * deriving a feed from a candidate's own stated preferences is not an automated action
 * against a third party.
 *
 * THE PER-CANDIDATE DISCOVERY FETCH THAT USED TO LIVE HERE IS RETIRED. It fetched the
 * keyless public sources separately for every authorized candidate — the same requests,
 * repeated — while the shared corpus is now refreshed once by schedulerTasks'
 * keyless-ingestion-enqueue task. Nothing candidate-specific was left for it to do:
 * fit-analysis jobs are enqueued on a vacancy's transition into VERIFIED
 * (scoreVacancy -> enqueueFitJobsForVacancy), and ranking has this task.
 *
 * BUDGETS ARE PER TICK, NOT PER CORPUS. A tick stops at maxCandidates or at the tick
 * deadline and the remainder waits for the next tick, so a schedule can never turn into
 * one unbounded run. A candidate failure is isolated: the tick continues.
 */

/**
 * The only sources the unattended path may poll: the keyless, free public APIs.
 * Credentialed aggregators — Jooble's lifetime 500-request plan, Adzuna, SerpApi — are
 * deliberately absent. Consumed by schedulerTasks' keyless-ingestion-enqueue task, which
 * queues them into the SHARED corpus once rather than once per candidate.
 */
export const KEYLESS_SCHEDULED_SOURCE_CODES = ["remotive", "arbeitnow", "themuse"] as const;

export interface ScheduledRefreshBudget {
  maxCandidates: number;
  perCandidateDeadlineMs: number;
  tickDeadlineMs: number;
}

export const DEFAULT_SCHEDULED_REFRESH_MAX_CANDIDATES = 20;
export const DEFAULT_SCHEDULED_REFRESH_PER_CANDIDATE_DEADLINE_MS = 10_000;
export const DEFAULT_SCHEDULED_REFRESH_TICK_DEADLINE_MS = 120_000;

export function readScheduledRefreshBudget(
  env: Record<string, string | undefined> = process.env,
): ScheduledRefreshBudget {
  return {
    maxCandidates: readEnvInt(
      "SCHEDULER_REFRESH_MAX_CANDIDATES_PER_TICK",
      DEFAULT_SCHEDULED_REFRESH_MAX_CANDIDATES,
      env,
    ),
    perCandidateDeadlineMs: readEnvInt(
      "SCHEDULER_REFRESH_PER_CANDIDATE_DEADLINE_MS",
      DEFAULT_SCHEDULED_REFRESH_PER_CANDIDATE_DEADLINE_MS,
      env,
    ),
    tickDeadlineMs: readEnvInt(
      "SCHEDULER_REFRESH_TICK_DEADLINE_MS",
      DEFAULT_SCHEDULED_REFRESH_TICK_DEADLINE_MS,
      env,
    ),
  };
}

export interface ScheduledRankingRefreshSummary {
  candidatesConsidered: number;
  completed: number;
  failed: number;
  stillRunning: number;
  noTargetRoles: number;
  deadlineReached: boolean;
  /** Distinct ranking identities observed, so a tick that changed nothing is visible. */
  identities: string[];
}



export interface EnumeratedCandidate {
  candidate_id: string;
  reason: string;
}

export interface ScheduledRefreshDeps {
  enumerateCandidates: (
    client: RankingRefreshClient,
    limit: number,
  ) => Promise<readonly EnumeratedCandidate[]>;
  runRefresh: (
    client: RankingRefreshClient,
    candidateId: string,
    options: { force: boolean; deadlineMs: number },
  ) => Promise<RankingRefreshResult>;
}

/**
 * The real enumeration RPC. Bounded and deterministic server-side (ORDER BY
 * candidate_id), so a tick that stops at the cap resumes from the same place.
 */
async function enumerateCandidates(
  client: RankingRefreshClient,
  limit: number,
): Promise<readonly EnumeratedCandidate[]> {
  const { data, error } = await client.rpc("list_candidates_needing_ranking_refresh", { p_limit: limit });

  if (error) {
    throw error;
  }

  return ((data ?? []) as EnumeratedCandidate[]).map((row) => ({
    candidate_id: row.candidate_id,
    reason: row.reason,
  }));
}

const DEFAULT_DEPS: ScheduledRefreshDeps = {
  enumerateCandidates,
  runRefresh: (client, candidateId, options) => runRankingRefresh(client, candidateId, options),
};

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export interface RunScheduledOptions {
  budget?: ScheduledRefreshBudget;
  now?: () => number;
  deps?: Partial<ScheduledRefreshDeps>;
}

/**
 * One bounded tick of the scheduled ranking refresh. Candidates the RPC omits —
 * no selected roles, already current, failed (explicit-retry only) or live-leased
 * — are never touched here.
 */
export async function runScheduledRankingRefresh(
  client: RankingRefreshClient,
  options: RunScheduledOptions = {},
): Promise<ScheduledRankingRefreshSummary> {
  const budget = options.budget ?? readScheduledRefreshBudget();
  const now = options.now ?? (() => Date.now());
  const deps: ScheduledRefreshDeps = { ...DEFAULT_DEPS, ...options.deps };
  const deadline = now() + budget.tickDeadlineMs;

  const candidates = await deps.enumerateCandidates(client, budget.maxCandidates);

  const summary: ScheduledRankingRefreshSummary = {
    candidatesConsidered: 0,
    completed: 0,
    failed: 0,
    stillRunning: 0,
    noTargetRoles: 0,
    deadlineReached: false,
    identities: [],
  };

  for (const candidate of candidates) {
    if (summary.candidatesConsidered >= budget.maxCandidates) break;

    if (now() >= deadline) {
      summary.deadlineReached = true;
      break;
    }

    summary.candidatesConsidered += 1;

    try {
      // force: false — a scheduled pass NEVER re-arms a failed refresh. Only the
      // explicit user retry on the manual route does that.
      const result = await deps.runRefresh(client, candidate.candidate_id, {
        force: false,
        deadlineMs: budget.perCandidateDeadlineMs,
      });

      if (result.outcome === "succeeded") summary.completed += 1;
      else if (result.outcome === "failed") summary.failed += 1;
      else if (result.outcome === "no_target_roles") summary.noTargetRoles += 1;
      else summary.stillRunning += 1;

      if (result.identity && !summary.identities.includes(result.identity)) {
        summary.identities.push(result.identity);
      }
    } catch (error) {
      // One bad candidate must not end the tick.
      summary.failed += 1;
      console.error("[scheduler] ranking refresh candidate failed", {
        candidateId: candidate.candidate_id,
        error: describeError(error),
      });
    }
  }

  return summary;
}


