import type { DiscoveredVacancy, FetchImpl } from "../../ingestion/types.js";

/**
 * Task W — the on-demand intake adapter contract.
 *
 * WHY THIS IS A SECOND INTERFACE AND NOT A SECOND REGISTRY.
 *
 * server/ingestion/adapters already defines a DiscoveryAdapter, and the two are
 * deliberately adjacent rather than unified. They answer different questions:
 *
 *   DiscoveryAdapter.discover(targetKey, config, fetch)
 *     "poll this known board, configured in vacancy_sources, on a schedule."
 *     Driven by ingestion_jobs, gated on source_policies.discovery_allowed,
 *     and its results expire anything the run did not see.
 *
 *   IntakeAdapter.fetchLiveJobs(query, fetch)
 *     "find me currently-open postings matching this, right now."
 *     Driven by a human or an agent, with no scheduler, and it never expires
 *     anything it did not see — a targeted search is not a full sweep, and
 *     treating it as one would expire the entire table on the first query.
 *
 * What they DO share is the part where drift would actually hurt: both emit
 * DiscoveredVacancy, and both are written through ingestDiscoveredVacancy. The
 * normalization target, the dedup rules, the company upsert and the fingerprint
 * are one implementation. Only the fetch trigger differs.
 */
export interface IntakeQuery {
  /**
   * Free-text search. Empty means "whatever this source returns by default",
   * which is what an unfiltered browse is.
   */
  search?: string;
  /**
   * Role keywords, already joined into ONE comma-separated string by the caller.
   *
   * Pre-joined rather than a list, and that is a quota decision rather than a
   * typing preference: Jooble's free plan is a lifetime total of 500 requests
   * per key, so a candidate with five selected roles must cost one request, not
   * five. An adapter that received an array would be free to loop over it, and
   * the cheapest way to make that impossible is to never hand it the array.
   */
  keywords?: string;
  /**
   * Freeform place name to search around (Jooble's `location`). Jooble
   * documents keywords and location as BOTH required, so an adapter for it must
   * treat a missing one as "cannot run" rather than falling back to a guess.
   */
  location?: string;
  /**
   * ISO-3166 alpha-2 country code, already lower-cased by the caller. Adzuna
   * takes it as a URL path segment. Only ever set when the candidate's stated
   * preference was genuinely a two-letter code — see intake/queryContext.ts for
   * why a country NAME is never converted into one.
   */
  country?: string;
  /** Upper bound on postings returned, applied after the adapter's own filtering. */
  limit: number;
}

/**
 * What one fetch produced, including the listings it could not use.
 *
 * The counts are the adapter's own report rather than something the caller
 * derives, because only the adapter has seen the raw payload. Without them,
 * "ingested 4 of the 20 you asked for" has no explanation — and a number the
 * caller cannot explain is one it should not be printing.
 */
export interface IntakeFetchResult {
  vacancies: DiscoveredVacancy[];
  /** Listings the source returned, before this adapter filtered or dropped any. */
  received: number;
  /** Listings that could not be mapped (missing an id, url, title or company). */
  skipped: number;
}

export interface IntakeAdapter {
  /** source_code this adapter writes under. Must have a source_policies row. */
  readonly sourceCode: string;
  /** Human-readable name, surfaced in the MCP tool listing and in evidence. */
  readonly displayName: string;
  /**
   * Where the data comes from, and anything a caller must honour when using it.
   * Carried on the adapter itself because the obligations travel with the
   * source: Remotive's attribution requirement is a property of Remotive, not
   * of one call site.
   */
  readonly attribution: string;
  /**
   * Fetches currently-open postings. Must not throw for an empty result — an
   * empty array is a legitimate answer, and conflating it with a failure would
   * make "no matches" indistinguishable from "the API is down".
   */
  fetchLiveJobs(query: IntakeQuery, fetchImpl?: FetchImpl): Promise<IntakeFetchResult>;
}
