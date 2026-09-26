import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Source health — the server-side data layer behind
 * GET /api/admin/source-health.
 *
 * WHAT THIS READS. public.source_health_events (20260813205350) is the
 * per-run log of every source fetch: one row per attempt, written by the
 * on-demand intake path (server/intake/intake.ts) and the scheduled worker
 * (server/ingestion/worker.ts). Until now its only reader was the ingestion
 * runner's own cooldown check, so "did this source work, and when" was not
 * answerable from the console.
 *
 * READ-ONLY BY CONSTRUCTION. The table grants service_role SELECT and INSERT
 * only — no UPDATE, no DELETE — so this module has no write path to offer and
 * the log is append-only. Nothing here can alter history.
 *
 * WHAT IS NOT IN HERE, and cannot be without a schema change: a policy refusal
 * (kill switch on, discovery_allowed false, no source_policies row, no
 * vacancy_sources row) throws before the fetch is attempted, so it writes no
 * row at all. A rate limit does write a row, but as status 'error' with the
 * status code only inside error_message — there is no status_code column and
 * 'success'/'error' is the whole CHECK. Both limits are stated in the UI rather
 * than papered over here.
 */

export type SourceHealthStatus = "success" | "error";

export const SOURCE_HEALTH_STATUSES: readonly SourceHealthStatus[] = ["success", "error"];

export function isSourceHealthStatus(value: unknown): value is SourceHealthStatus {
  return typeof value === "string" && (SOURCE_HEALTH_STATUSES as readonly string[]).includes(value);
}

/**
 * Same bound as listAuditEvents (server/audit/log.ts): newest N, clamped, never
 * unbounded. source_health_events is append-only and has no retention policy,
 * so its row count only grows and an unbounded read would eventually be a query
 * that cannot finish.
 */
export const DEFAULT_SOURCE_HEALTH_LIMIT = 100;
export const MAX_SOURCE_HEALTH_LIMIT = 500;

export function clampSourceHealthLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_SOURCE_HEALTH_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SOURCE_HEALTH_LIMIT);
}

export interface SourceHealthEvent {
  id: string;
  sourceCode: string;
  /** Null when the row predates the target, or its vacancy_sources row was deleted (ON DELETE SET NULL). */
  vacancySourceId: string | null;
  status: SourceHealthStatus;
  vacanciesFetched: number;
  /**
   * The adapter's own message on a failure. This is where the useful detail
   * lives: an HTTP status, Jooble's "requires keywords", the Muse's named
   * rate-limit explanation. Null on success.
   */
  errorMessage: string | null;
  durationMs: number | null;
  runAt: string;
}

/**
 * One source's rollup over the events actually returned.
 *
 * SCOPED TO THE RETURNED WINDOW, NOT THE WHOLE TABLE, and the field names say
 * so. A source whose most recent run falls outside the page has no entry here
 * at all, and when a status filter is applied these figures describe the
 * matching rows only — which is why they are labelled "in window" rather than
 * presented as lifetime totals.
 */
export interface SourceHealthSummary {
  sourceCode: string;
  latestRunAt: string;
  latestStatus: SourceHealthStatus;
  latestErrorMessage: string | null;
  latestVacanciesFetched: number;
  latestDurationMs: number | null;
  /** Rows for this source within the returned window. */
  eventsInWindow: number;
  errorsInWindow: number;
}

export interface SourceHealthList {
  events: SourceHealthEvent[];
  /** Latest run per source, derived from `events`. See SourceHealthSummary. */
  sources: SourceHealthSummary[];
  /** The clamped page size actually applied, so a caller can label the window truthfully. */
  limit: number;
  /** True when older rows exist beyond the window. */
  truncated: boolean;
}

export interface ListSourceHealthOptions {
  limit?: number;
  /** Exact source_code match. Null or omitted means every source. */
  sourceCode?: string | null;
  status?: SourceHealthStatus | null;
}

interface SourceHealthRow {
  id: string;
  source_code: string;
  vacancy_source_id: string | null;
  status: SourceHealthStatus;
  vacancies_fetched: number;
  error_message: string | null;
  duration_ms: number | null;
  run_at: string;
}

export async function listSourceHealthEvents(
  client: SupabaseClient,
  options: ListSourceHealthOptions = {},
): Promise<SourceHealthList> {
  const limit = clampSourceHealthLimit(options.limit);

  let query = client
    .from("source_health_events")
    .select("id, source_code, vacancy_source_id, status, vacancies_fetched, error_message, duration_ms, run_at");

  if (options.sourceCode) {
    query = query.eq("source_code", options.sourceCode);
  }

  if (options.status) {
    query = query.eq("status", options.status);
  }

  // limit + 1 so "are there older rows?" is answered by the data rather than
  // inferred from a full page — a page that happens to be exactly full is
  // otherwise indistinguishable from the end of the table.
  const { data, error } = await query.order("run_at", { ascending: false }).limit(limit + 1);

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as SourceHealthRow[];
  const truncated = rows.length > limit;

  const events = rows.slice(0, limit).map((row) => ({
    id: row.id,
    sourceCode: row.source_code,
    vacancySourceId: row.vacancy_source_id,
    status: row.status,
    vacanciesFetched: row.vacancies_fetched,
    errorMessage: row.error_message,
    durationMs: row.duration_ms,
    runAt: row.run_at,
  }));

  return { events, sources: summarizeBySource(events), limit, truncated };
}

/**
 * Latest run per source, plus how many of the returned rows each contributed.
 *
 * Order-independent on purpose: the latest row is picked by comparing run_at
 * rather than by assuming the caller passed events newest-first, so a summary
 * derived from a re-sorted or filtered list is still correct within that list.
 */
export function summarizeBySource(events: SourceHealthEvent[]): SourceHealthSummary[] {
  const bySource = new Map<string, SourceHealthSummary>();

  for (const event of events) {
    const existing = bySource.get(event.sourceCode);

    if (!existing) {
      bySource.set(event.sourceCode, {
        sourceCode: event.sourceCode,
        latestRunAt: event.runAt,
        latestStatus: event.status,
        latestErrorMessage: event.errorMessage,
        latestVacanciesFetched: event.vacanciesFetched,
        latestDurationMs: event.durationMs,
        eventsInWindow: 1,
        errorsInWindow: event.status === "error" ? 1 : 0,
      });
      continue;
    }

    existing.eventsInWindow += 1;

    if (event.status === "error") {
      existing.errorsInWindow += 1;
    }

    if (event.runAt > existing.latestRunAt) {
      existing.latestRunAt = event.runAt;
      existing.latestStatus = event.status;
      existing.latestErrorMessage = event.errorMessage;
      existing.latestVacanciesFetched = event.vacanciesFetched;
      existing.latestDurationMs = event.durationMs;
    }
  }

  // Sorted by source so the table order is stable across refetches, rather
  // than following whichever source happened to run most recently.
  return [...bySource.values()].sort((a, b) => a.sourceCode.localeCompare(b.sourceCode));
}
