import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_INDEX_BATCH_SIZE,
  DEFAULT_INDEX_MAX_BATCHES,
  indexVacancyEvidence,
} from "./indexEvidence.js";
import {
  DEFAULT_MATCH_BATCH_SIZE,
  DEFAULT_MATCH_MAX_BATCHES,
  materializeCandidateRoleMatches,
} from "./materializeRoleMatches.js";
import { refreshCandidateQualifierTokens } from "../applications/candidateQualifierTokens.js";

/**
 * The MANUAL feed-ranking refresh workflow (D1-RANK-REFRESH).
 *
 * WHAT IT COORDINATES, in order, because each step depends on the previous one:
 *   1. SHARED posting-evidence indexing (indexVacancyEvidence). Refreshing only
 *      candidate data is useless while posting evidence is unindexed, and the
 *      work is shared, so it is leased globally and never repeated per candidate.
 *   2. This candidate's qualifier derivation/publication
 *      (refreshCandidateQualifierTokens). Atomic; 'stale' is a lost compare-and-
 *      swap, not an error.
 *   3. This candidate's role-match materialisation
 *      (materializeCandidateRoleMatches). Batched and cursor-resumable.
 *
 * IT IS BOUNDED, RESUMABLE AND DEDUPLICATED. Every invocation works to a wall
 * clock deadline and persists what it reached, so a cold corpus completes across
 * bounded authenticated requests rather than one giant request. A per-candidate
 * lease means concurrent requests do not run duplicate scans, and the singleton
 * posting-index lease means the shared index is never done twice at once.
 *
 * IT NEVER PUBLISHES A PARTIAL RESULT AS COMPLETE. Reaching the deadline records
 * 'pending' (continue), a thrown failure records 'failed' with the message, and
 * only a genuinely complete materialisation records 'succeeded'. Nothing here
 * touches an external provider, spends money, submits an application or activates
 * a task.
 */

export type RankingRefreshOutcome = "no_target_roles" | "running" | "succeeded" | "failed";

export interface RankingRefreshResult {
  outcome: RankingRefreshOutcome;
  phase: "none" | "indexing" | "matching";
  /** The candidate's ranking state AFTER this invocation. */
  state: string;
  /** The ranking identity AFTER this invocation, or null when not applicable. */
  identity: string | null;
  /** FAILURE attempts consumed so far, not continuation steps. */
  attempts: number;
  /** True when an explicit retry may proceed. */
  retryable: boolean;
  lastError: string | null;
  evidenceIndexed: number;
  scanned: number;
  matched: number;
  /** True when this invocation stopped because its deadline ran out. */
  deadlineReached: boolean;
}

/**
 * The three real collaborators, injectable so the coordination logic — leases,
 * continuation, failure recording and the "never publish a partial sweep as
 * complete" rule — can be tested without a database. Production uses the defaults.
 */
export interface RankingRefreshDeps {
  indexEvidence: typeof indexVacancyEvidence;
  refreshQualifiers: typeof refreshCandidateQualifierTokens;
  materializeMatches: typeof materializeCandidateRoleMatches;
}

const DEFAULT_DEPS: RankingRefreshDeps = {
  indexEvidence: indexVacancyEvidence,
  refreshQualifiers: refreshCandidateQualifierTokens,
  materializeMatches: materializeCandidateRoleMatches,
};

export interface RankingRefreshOptions {
  /** Explicit retry / role-change trigger. Continuation polls leave this false. */
  force?: boolean;
  /** Wall-clock budget for this invocation. Defaults to 10s. */
  deadlineMs?: number;
  /** Injectable clock, for testing the deadline without waiting. */
  now?: () => number;
  indexBatchSize?: number;
  indexMaxBatches?: number;
  matchBatchSize?: number;
  matchMaxBatches?: number;
  /** Test seam; production omits it. */
  deps?: Partial<RankingRefreshDeps>;
}

export const DEFAULT_RANKING_REFRESH_DEADLINE_MS = 10_000;

export type RankingRefreshClient = Pick<SupabaseClient, "from" | "rpc">;

interface RefreshRow {
  candidate_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  leased_until: string | null;
}

interface IndexStateRow {
  id: boolean;
  status: string;
  cursor_offset: number;
  leased_until: string | null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** PostgREST returns set-returning functions as arrays and composites as objects. */
function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null;
  if (data !== null && typeof data === "object") return data as T;
  return null;
}

async function readRankingState(client: RankingRefreshClient, candidateId: string): Promise<string> {
  const { data, error } = await client.rpc("candidate_ranking_state", { p_candidate_id: candidateId });
  if (error) throw error;
  return typeof data === "string" ? data : "unavailable";
}

async function readRankingIdentity(client: RankingRefreshClient, candidateId: string): Promise<string | null> {
  const { data, error } = await client.rpc("candidate_ranking_identity", { p_candidate_id: candidateId });
  if (error) throw error;
  return typeof data === "string" ? data : null;
}

async function readEvidenceComplete(client: RankingRefreshClient): Promise<boolean> {
  const { data, error } = await client.rpc("posting_evidence_complete");
  if (error) throw error;
  return data === true;
}

async function readRefreshRow(client: RankingRefreshClient, candidateId: string): Promise<RefreshRow | null> {
  const { data, error } = await client
    .from("candidate_ranking_refresh")
    .select("candidate_id, status, attempts, max_attempts, last_error, leased_until")
    .eq("candidate_id", candidateId)
    .maybeSingle();
  if (error) throw error;
  return (data as RefreshRow | null) ?? null;
}

/**
 * The one place the workflow decides whether to (re)arm the refresh.
 *
 * A ROLE CHANGE FORCES IT. The caller passes force: true after a save/edit/clear,
 * and the route also auto-forces when the visible state is not current and no
 * refresh is in flight or failed. A FAILED refresh is NEVER auto-forced: only an
 * explicit retry re-arms it, so a poisoned candidate cannot be retried in a loop
 * by ordinary polling.
 */
function shouldForce(state: string, row: RefreshRow | null, explicit: boolean): boolean {
  if (explicit) return true;
  if (state === "current" || state === "no_target_roles") return false;
  return row === null || row.status === "idle" || row.status === "succeeded";
}

export async function runRankingRefresh(
  client: RankingRefreshClient,
  candidateId: string,
  options: RankingRefreshOptions = {},
): Promise<RankingRefreshResult> {
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.deadlineMs ?? DEFAULT_RANKING_REFRESH_DEADLINE_MS);
  const deps: RankingRefreshDeps = { ...DEFAULT_DEPS, ...options.deps };

  let evidenceIndexed = 0;
  let scanned = 0;
  let matched = 0;

  // A candidate with no target roles has nothing to rank and must NOT trigger the
  // shared posting sweep: there is no preference for it to serve.
  const state = await readRankingState(client, candidateId);
  if (state === "no_target_roles") {
    return {
      outcome: "no_target_roles",
      phase: "none",
      state,
      identity: null,
      attempts: 0,
      retryable: false,
      lastError: null,
      evidenceIndexed,
      scanned,
      matched,
      deadlineReached: false,
    };
  }

  const existing = await readRefreshRow(client, candidateId);
  const force = shouldForce(state, existing, options.force === true);

  const { error: requestError } = await client.rpc("request_candidate_ranking_refresh", {
    p_candidate_id: candidateId,
    p_force: force,
  });
  if (requestError) throw requestError;

  const { data: claimData, error: claimError } = await client.rpc("claim_candidate_ranking_refresh", {
    p_candidate_id: candidateId,
  });
  if (claimError) throw claimError;

  const claim = firstRow<RefreshRow>(claimData);

  if (claim === null) {
    // Not claimable: another request holds a live lease, or the refresh is in a
    // terminal failure that only an explicit retry may re-arm.
    const row = await readRefreshRow(client, candidateId);
    const latestState = await readRankingState(client, candidateId);
    const identity = latestState === "no_target_roles" ? null : await readRankingIdentity(client, candidateId);
    const attempts = row?.attempts ?? 0;
    const maxAttempts = row?.max_attempts ?? 5;

    if (row?.status === "failed") {
      return {
        outcome: "failed",
        phase: "none",
        state: latestState,
        identity,
        attempts,
        retryable: attempts < maxAttempts,
        lastError: row.last_error,
        evidenceIndexed,
        scanned,
        matched,
        deadlineReached: false,
      };
    }

    return {
      outcome: "running",
      phase: "matching",
      state: latestState,
      identity,
      attempts,
      retryable: true,
      lastError: null,
      evidenceIndexed,
      scanned,
      matched,
      deadlineReached: false,
    };
  }

  let phase: "indexing" | "matching" = "indexing";
  let lastError: string | null = null;

  try {
    // 1. SHARED posting evidence. Bounded per invocation; the singleton lease
    //    means one request at a time and the persisted cursor resumes the sweep.
    while (now() < deadline) {
      if (await readEvidenceComplete(client)) break;

      const { data: indexClaimData, error: indexClaimError } = await client.rpc("claim_posting_evidence_index");
      if (indexClaimError) throw indexClaimError;

      const indexClaim = firstRow<IndexStateRow>(indexClaimData);
      if (indexClaim === null) {
        // Someone else is indexing the shared corpus; do not spin.
        break;
      }

      const startOffset = indexClaim.cursor_offset ?? 0;
      const indexResult = await deps.indexEvidence(client, {
        offset: startOffset,
        batchSize: options.indexBatchSize ?? DEFAULT_INDEX_BATCH_SIZE,
        maxBatches: options.indexMaxBatches ?? DEFAULT_INDEX_MAX_BATCHES,
      });

      evidenceIndexed += indexResult.indexed;
      lastError = indexResult.failures.length > 0 ? indexResult.failures[0].error : null;

      // A failed batch is retried, not skipped past: keep the previous offset so
      // the next invocation re-reads those rows (already-current rows are cheap).
      const nextOffset = indexResult.failures.length > 0 ? startOffset : indexResult.nextOffset;
      const done = indexResult.done && indexResult.failures.length === 0;

      const { error: advanceError } = await client.rpc("advance_posting_evidence_index", {
        p_cursor_offset: nextOffset,
        p_done: done,
        p_scanned: indexResult.examined,
        p_indexed: indexResult.indexed,
        p_last_error: lastError,
      });
      if (advanceError) throw advanceError;

      if (lastError !== null) break;
    }

    if (!(await readEvidenceComplete(client))) {
      phase = "indexing";
      await finish(client, candidateId, "pending", lastError);
      const pendingState = await readRankingState(client, candidateId);
      return {
        outcome: "running",
        phase,
        state: pendingState,
        identity: pendingState === "no_target_roles" ? null : await readRankingIdentity(client, candidateId),
        attempts: claim.attempts,
        retryable: true,
        lastError,
        evidenceIndexed,
        scanned,
        matched,
        deadlineReached: now() >= deadline,
      };
    }

    // 2. This candidate's qualifier generation. 'stale' is a lost compare-and-swap
    //    (a newer refresh owns publication), never a failure.
    phase = "matching";
    await deps.refreshQualifiers(client, candidateId);

    // 3. This candidate's role matches, bounded and cursor-resumable.
    let corpusComplete = false;
    while (now() < deadline) {
      const result = await deps.materializeMatches(client, candidateId, {
        batchSize: options.matchBatchSize ?? DEFAULT_MATCH_BATCH_SIZE,
        maxBatches: options.matchMaxBatches ?? DEFAULT_MATCH_MAX_BATCHES,
      });

      scanned += result.scanned;
      matched += result.matched;

      if (result.status === "failed") {
        throw new Error(result.error ?? "role-match materialisation failed");
      }

      if (result.status === "complete" && result.corpusComplete) {
        corpusComplete = true;
        break;
      }

      // 'running' or 'stale': keep going within the deadline. 'stale' means the
      // corpus moved and the next call restarts at the new version.
    }

    if (corpusComplete) {
      await finish(client, candidateId, "succeeded", null);
      return {
        outcome: "succeeded",
        phase: "matching",
        state: await readRankingState(client, candidateId),
        identity: await readRankingIdentity(client, candidateId),
        attempts: claim.attempts,
        retryable: false,
        lastError: null,
        evidenceIndexed,
        scanned,
        matched,
        deadlineReached: now() >= deadline,
      };
    }

    await finish(client, candidateId, "pending", null);
    const runningState = await readRankingState(client, candidateId);
    return {
      outcome: "running",
      phase: "matching",
      state: runningState,
      identity: runningState === "no_target_roles" ? null : await readRankingIdentity(client, candidateId),
      attempts: claim.attempts,
      retryable: true,
      lastError: null,
      evidenceIndexed,
      scanned,
      matched,
      deadlineReached: now() >= deadline,
    };
  } catch (error) {
    const message = describeError(error);
    await finish(client, candidateId, "failed", message);
    const attempts = claim.attempts + 1;
    const failedState = await readRankingState(client, candidateId);

    return {
      outcome: "failed",
      phase,
      state: failedState,
      identity: failedState === "no_target_roles" ? null : await readRankingIdentity(client, candidateId),
      attempts,
      retryable: attempts < claim.max_attempts,
      lastError: message,
      evidenceIndexed,
      scanned,
      matched,
      deadlineReached: now() >= deadline,
    };
  }
}

async function finish(
  client: RankingRefreshClient,
  candidateId: string,
  status: "pending" | "succeeded" | "failed",
  lastError: string | null,
): Promise<void> {
  const { error } = await client.rpc("finish_candidate_ranking_refresh", {
    p_candidate_id: candidateId,
    p_status: status,
    p_last_error: lastError,
  });
  if (error) throw error;
}
