import type { SupabaseClient } from "@supabase/supabase-js";
import { findActiveCandidateIds } from "../applications/activeCandidates.js";
import { readEnvInt } from "../config/envInt.js";
import { loadIntakeQueryContext } from "../intake/queryContext.js";
import { runIntakeAcrossSources, type RunIntakeFanOutResult } from "../intake/intake.js";
import { runRankingRefresh, type RankingRefreshClient, type RankingRefreshResult } from "./rankingRefresh.js";

/**
 * BATCH C — the SCHEDULED callers of the refresh workflow.
 *
 * Two independent tasks, both driven by the existing scheduler daemon
 * (server/schedulerTasks.ts); no new daemon, queue or pg-boss:
 *
 *   * RANKING REFRESH is DB-only over each candidate's own rows. It enumerates
 *     candidates whose ranking is not current (service-role RPC) and runs the
 *     SAME runRankingRefresh the manual route uses, bounded per candidate and per
 *     tick. It needs no automation consent: deriving a feed from a candidate's own
 *     stated preferences is not an automated action against a third party.
 *
 *   * DISCOVERY reaches the network, so it is gated on
 *     automation_authorizations.status = 'authorized' (findActiveCandidateIds) and
 *     restricted to the KEYLESS public sources. It calls the same
 *     loadIntakeQueryContext -> runIntakeAcrossSources pair the on-demand route
 *     calls, so source_policies (discovery_allowed, kill_switch) are enforced by
 *     that layer. It makes NO model call and submits NOTHING.
 *
 * BUDGETS ARE PER TICK, NOT PER CORPUS. A tick stops at maxCandidates or at the
 * tick deadline and the remainder waits for the next tick, so a schedule can
 * never turn into one unbounded run. A candidate failure is isolated: the tick
 * continues.
 */

/**
 * The ONLY sources an unattended run may poll today: the keyless, free public
 * APIs. The registry filters this list to what is actually registered, so The
 * Muse is included only when its opt-in flag is set. Adzuna, Jooble, SerpApi and
 * every credentialed adapter are deliberately absent.
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

export interface ScheduledDiscoverySummary {
  candidatesConsidered: number;
  created: number;
  updated: number;
  failed: number;
  failedSources: number;
  deadlineReached: boolean;
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
  findActiveCandidateIds: (client: SupabaseClient) => Promise<string[]>;
  loadContext: (
    client: SupabaseClient,
    candidateId: string,
  ) => Promise<{ keywords?: string; location?: string; country?: string }>;
  runIntake: (
    client: SupabaseClient,
    input: { sourceCodes: readonly string[]; keywords?: string; location?: string; country?: string; deadlineMs: number },
  ) => Promise<RunIntakeFanOutResult>;
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
  findActiveCandidateIds,
  loadContext: (client, candidateId) => loadIntakeQueryContext(client, candidateId),
  runIntake: (client, input) => runIntakeAcrossSources(client, input),
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

/**
 * One bounded tick of scheduled discovery. Authorization is enforced by
 * findActiveCandidateIds; provider policy and kill switches by the intake layer.
 * No model call and no submission happen here.
 */
export async function runScheduledDiscovery(
  client: SupabaseClient,
  options: RunScheduledOptions = {},
): Promise<ScheduledDiscoverySummary> {
  const budget = options.budget ?? readScheduledRefreshBudget();
  const now = options.now ?? (() => Date.now());
  const deps: ScheduledRefreshDeps = { ...DEFAULT_DEPS, ...options.deps };
  const deadline = now() + budget.tickDeadlineMs;

  // Sorted for a deterministic, resumable order across ticks.
  const candidateIds = [...(await deps.findActiveCandidateIds(client))].sort();

  const summary: ScheduledDiscoverySummary = {
    candidatesConsidered: 0,
    created: 0,
    updated: 0,
    failed: 0,
    failedSources: 0,
    deadlineReached: false,
  };

  for (const candidateId of candidateIds) {
    if (summary.candidatesConsidered >= budget.maxCandidates) break;

    if (now() >= deadline) {
      summary.deadlineReached = true;
      break;
    }

    summary.candidatesConsidered += 1;

    try {
      const context = await deps.loadContext(client, candidateId);
      const result = await deps.runIntake(client, {
        sourceCodes: KEYLESS_SCHEDULED_SOURCE_CODES,
        keywords: context.keywords,
        location: context.location,
        country: context.country,
        deadlineMs: budget.perCandidateDeadlineMs,
      });

      summary.created += result.created;
      summary.updated += result.updated;
      summary.failedSources += result.failedSources;
      if (result.stoppedOnDeadline) summary.deadlineReached = true;
    } catch (error) {
      summary.failed += 1;
      console.error("[scheduler] discovery candidate failed", {
        candidateId,
        error: describeError(error),
      });
    }
  }

  return summary;
}
