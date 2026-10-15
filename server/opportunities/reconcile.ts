import type { SupabaseClient } from "@supabase/supabase-js";
import { findActiveCandidateIds } from "../applications/activeCandidates.js";
import { PRIORITY_SCORE_VERSION } from "../../shared/priorityScore.js";

/**
 * Opportunity Intelligence Phase 2.3c — the reconcile pass.
 *
 * Phase 2.3b added the stored priority columns but deliberately shipped no
 * backfill: recomputing an analysis is the worker's job, not a migration's.
 * This closes that gap, and generalises past it — by also re-arming rows
 * whose priority_score_version has fallen behind, it doubles as the standing
 * "re-score everything after a scoring-policy bump" tool.
 *
 * Cheap by design: it only ENQUEUES. The fit worker drains the queue as
 * usual, and analyzeFit's AI-skip guard means a row whose JD snapshot and
 * confirmed facts are unchanged is re-scored WITHOUT an AI call. A
 * version-bump reconcile over already-analysed rows therefore costs
 * database work and no model tokens; only genuinely missing analyses pay
 * for inference.
 *
 * Enqueue-only on purpose (no inline drain): the lease queue is already the
 * drain mechanism, and keeping one pass to one job means a huge reconcile
 * cannot stall behind model latency.
 */

/** Default ceiling on jobs enqueued per invocation. */
const DEFAULT_RECONCILE_LIMIT = 500;

/**
 * How many ids go into ONE PostgREST `.in()` filter.
 *
 * NOT a paging preference — a URL-LENGTH bound. PostgREST carries the filter as a query
 * parameter, so the whole id list has to fit in a URI. MEASURED against this database: 743
 * eligible vacancies produced a ~28.9 KB filter and the gateway answered
 * {"message":"URI too long"}. 100 ids is ~3.9 KB per request, inside the usual 8 KB proxy
 * default, and 8 requests for a 743-vacancy catalogue.
 */
const READ_CHUNK_SIZE = 100;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

const RECONCILABLE_TRUST_STATUSES = ["VERIFIED", "VERIFIED_INCOMPLETE"];

export interface ReconcileOptions {
  /** Maximum jobs to enqueue in one pass. Defaults to 500. */
  limit?: number;
}

export interface ReconcileResult {
  candidates: number;
  vacancies: number;
  /** (candidate, vacancy) pairs examined. */
  scanned: number;
  enqueued: number;
  /** Pairs already scored at the current version. */
  skipped: number;
  /** True when the limit stopped the pass early — run it again. */
  truncated: boolean;
}

interface ExistingScoreRow {
  candidate_id: string;
  vacancy_id: string;
  priority_score: number | null;
  priority_score_version: string | null;
}

function pairKey(candidateId: string, vacancyId: string): string {
  return `${candidateId}|${vacancyId}`;
}

export async function reconcileFitAnalyses(
  client: SupabaseClient,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const limit = options.limit ?? DEFAULT_RECONCILE_LIMIT;

  const result: ReconcileResult = {
    candidates: 0,
    vacancies: 0,
    scanned: 0,
    enqueued: 0,
    skipped: 0,
    truncated: false,
  };

  // Same definition of "active candidate" as the vacancy-side enqueue —
  // authorized automation plus at least one selected role.
  const candidateIds = await findActiveCandidateIds(client);
  result.candidates = candidateIds.length;
  if (candidateIds.length === 0) {
    return result;
  }

  const { data: vacancyRows, error: vacancyError } = await client
    .from("vacancies")
    .select("id")
    .in("trust_status", RECONCILABLE_TRUST_STATUSES)
    .eq("status", "active");

  if (vacancyError) {
    throw vacancyError;
  }

  const vacancyIds = ((vacancyRows ?? []) as Array<{ id: string }>).map((v) => v.id);
  result.vacancies = vacancyIds.length;
  if (vacancyIds.length === 0) {
    return result;
  }

  // One sweep of what is already scored, keyed by pair. Scoped to the candidates and
  // vacancies in play so this does not read the whole table.
  //
  // CHUNKED ON BOTH FILTERS, because either id list can be the one that overflows the URI.
  // This pass used to send both lists whole and therefore threw "URI too long" against any
  // catalogue of a few hundred vacancies — the back-fill it exists to perform never ran.
  // Chunking loses nothing: the union of the chunks is the same set of pairs.
  const current = new Set<string>();

  for (const candidateChunk of chunk(candidateIds, READ_CHUNK_SIZE)) {
    for (const vacancyChunk of chunk(vacancyIds, READ_CHUNK_SIZE)) {
      const { data: existingRows, error: existingError } = await client
        .from("fit_analyses")
        .select("candidate_id, vacancy_id, priority_score, priority_score_version")
        .in("candidate_id", candidateChunk)
        .in("vacancy_id", vacancyChunk);

      if (existingError) {
        throw existingError;
      }

      for (const row of (existingRows ?? []) as ExistingScoreRow[]) {
        if (row.priority_score !== null && row.priority_score_version === PRIORITY_SCORE_VERSION) {
          current.add(pairKey(row.candidate_id, row.vacancy_id));
        }
      }
    }
  }

  const stale: Array<{ candidate_id: string; vacancy_id: string }> = [];

  outer: for (const candidateId of candidateIds) {
    for (const vacancyId of vacancyIds) {
      result.scanned += 1;

      if (current.has(pairKey(candidateId, vacancyId))) {
        result.skipped += 1;
        continue;
      }

      stale.push({ candidate_id: candidateId, vacancy_id: vacancyId });

      if (stale.length >= limit) {
        result.truncated = true;
        break outer;
      }
    }
  }

  if (stale.length === 0) {
    return result;
  }

  // Same upsert shape as enqueueFitJobsForVacancy: re-arming an existing
  // done/failed row to 'pending' is how a re-analysis is requested.
  const { error: enqueueError } = await client.from("fit_analysis_jobs").upsert(
    stale.map((pair) => ({
      ...pair,
      status: "pending",
      attempts: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "candidate_id,vacancy_id" },
  );

  if (enqueueError) {
    throw enqueueError;
  }

  result.enqueued = stale.length;
  return result;
}
