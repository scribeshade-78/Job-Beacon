import type { DiscoveredVacancy, FetchImpl } from "../../ingestion/types.js";
import type { IntakeAdapter, IntakeFetchResult, IntakeQuery } from "./types.js";

/**
 * Arbeitnow — a free, public, keyless job board API, and the second browse-style
 * source alongside Remotive.
 *
 * THE PAYLOAD WAS READ FROM A REAL 200 BEFORE ANY OF THIS WAS WRITTEN. One live
 * GET returned 286 jobs / 2.34 MB, and the fixtures in the test file are that
 * response, trimmed. The verification was not ceremony — it settled a question
 * the documentation does not answer:
 *
 *   * `created_at` IS A UNIX EPOCH INTEGER IN SECONDS (Int64, e.g. 1790445314),
 *     not an ISO string and not milliseconds. Both wrong readings are plausible
 *     and both are silent: a string read would yield null on every row, and a
 *     milliseconds read would yield a date ~58,000 years out. parseArbeitnowCreatedAt
 *     therefore refuses anything outside a plausible year window rather than
 *     trusting the unit — see its comment.
 *   * `remote` IS A REAL BOOLEAN, so no token-scanning is needed here, unlike
 *     parseTheMuseRemoteType and parseSerpApiRemoteType.
 *   * `description` arrives HTML-ESCAPED (`&lt;div class=&quot;…`), i.e. escaped
 *     HTML rather than text. It only ever reaches `raw`, so it is not a
 *     correctness problem, but a future consumer must unescape it.
 *
 * NO SERVER-SIDE SEARCH EXISTS, WHICH IS WHY THIS ADAPTER FILTERS LOCALLY.
 * Arbeitnow documents exactly one query parameter — `visa_sponsorship` — plus
 * `?page=`; there is no keyword, title, tag or location filter. Remotive, by
 * contrast, has a real `search` parameter that its adapter passes through. So
 * the candidate's selected roles are matched here instead, and this is the only
 * adapter in the fan-out that does so.
 *
 * PAGINATION IS DELIBERATELY NOT FOLLOWED. `meta.info` says "Jobs are updated
 * every hour and order by the created_at timestamp. Use ?page= to paginate", and
 * `links.last` is null so the page count is not even knowable. One press of
 * "Fetch latest jobs" costs one request and returns the newest 286 jobs, which
 * is far more than the ranking algorithm will surface. Each further page would
 * be another 2.34 MB against an API whose own terms ask not to be abused.
 */

export const ARBEITNOW_SOURCE_CODE = "arbeitnow";
export const ARBEITNOW_API_BASE = "https://www.arbeitnow.com/api/job-board-api";

/** Which reading of Arbeitnow's terms these postings were ingested under. */
export const ARBEITNOW_NOTICE_VERSION = "arbeitnow-job-board-api-v1";

export class ArbeitnowPayloadError extends Error {
  constructor(detail: string) {
    super(`Arbeitnow returned a payload this adapter cannot read: ${detail}`);
    this.name = "ArbeitnowPayloadError";
  }
}

interface ArbeitnowJob {
  slug?: unknown;
  company_name?: unknown;
  title?: unknown;
  description?: unknown;
  remote?: unknown;
  url?: unknown;
  tags?: unknown;
  job_types?: unknown;
  location?: unknown;
  created_at?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Keeps string entries and drops anything else.
 *
 * The live payload's `tags` and `job_types` hold plain strings, but a loose
 * array is exactly the shape that silently degrades: `tags` feeds the role
 * filter, so an element that is not a string would quietly stop matching rather
 * than fail. Non-strings are dropped and, where they carry an obvious label
 * (`name`/`title`), that label is used instead — a small amount of defence
 * against a shape the API has not changed yet but has not promised either.
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return asString(entry);
      }
      if (typeof entry === "object" && entry !== null) {
        const record = entry as { name?: unknown; title?: unknown };
        return asString(record.name) ?? asString(record.title);
      }
      return null;
    })
    .filter((entry): entry is string => entry !== null);
}

/**
 * `created_at` is epoch SECONDS — verified against the live payload, where the
 * value is the Int64 1790445314.
 *
 * THE YEAR WINDOW IS A GUARD AGAINST A SILENT UNIT CHANGE, NOT PADDING. If the
 * API ever switches to milliseconds, `value * 1000` still produces a valid Date
 * — one roughly 58,000 years in the future — and every row would carry a
 * nonsense timestamp with nothing failing. Rejecting anything outside 2000–2100
 * turns that into a null, which is honest and visible, instead of a plausible-
 * looking number that is wrong. This is the same "an absent value is
 * recoverable, a wrong one is not" rule the date parsers in this directory
 * already follow.
 */
export function parseArbeitnowCreatedAt(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  const parsed = new Date(value * 1000);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const year = parsed.getUTCFullYear();

  return year < 2000 || year > 2100 ? null : parsed.toISOString();
}

/**
 * Whether a posting matches any of the candidate's selected roles.
 *
 * Substring, case-insensitive, against the TITLE and each TAG — the same
 * comparison eligibilityGate's role_match makes against vacancies.raw_title, so
 * a role that matches there matches here rather than the two disagreeing.
 *
 * An absent or blank `keywords` means NO FILTER, not "match nothing". A
 * candidate who has selected no roles still gets the newest postings, which is
 * the same answer Remotive gives when it sends no search term.
 */
export function matchesSelectedRoles(
  title: string,
  tags: readonly string[],
  keywords: string | undefined,
): boolean {
  const terms = (keywords ?? "")
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);

  if (terms.length === 0) {
    return true;
  }

  const haystack = [title, ...tags].join(" ").toLowerCase();

  return terms.some((term) => haystack.includes(term));
}

/**
 * Maps one Arbeitnow posting onto the shared DiscoveredVacancy shape.
 *
 * FOUR DELIBERATE NON-MAPPINGS:
 *
 * 1. country and city are NULL. `location` is free text — "Berlin, Berlin" is a
 *    city plus a state with no country in it. The whole string goes to `region`,
 *    the closest true column, as Remotive's candidate_required_location does.
 *
 * 2. companyDomain is NULL. Arbeitnow never publishes the employer's own domain,
 *    and deriving one from the company name is the "infer identity from a name"
 *    move the trust system scores against.
 *
 * 3. every salary column is NULL: the response carries no salary field at all.
 *
 * 4. remoteType is "remote" or null, never "hybrid" or "on_site". `remote` is a
 *    real boolean, so `true` is a statement the source made. `FALSE IS MAPPED TO
 *    NULL, NOT "on_site"`: Arbeitnow's docs say the field indicates whether the
 *    posting is remote "or not", but "not remote" does not distinguish on-site
 *    from hybrid, and remote_type is a column the candidate filters query. Only
 *    the claim the source actually made is carried.
 */
export function mapArbeitnowJob(job: ArbeitnowJob, fetchedAt: string): DiscoveredVacancy | null {
  const slug = asString(job.slug);
  const url = asString(job.url);
  const title = asString(job.title);
  const companyName = asString(job.company_name);

  // A posting missing any of these cannot be identified, linked to, or
  // attributed. Skipped rather than repaired, and counted so a caller can
  // explain a shortfall.
  if (!slug || !url || !title || !companyName) {
    return null;
  }

  const tags = toStringArray(job.tags);
  const jobTypes = toStringArray(job.job_types);

  return {
    sourceVacancyId: slug,
    // Arbeitnow's OWN page for the posting, which is also the link-back their
    // terms ask for ("I would appreciate linking back to the site").
    authoritativeUrl: url,
    rawTitle: title,
    companyName,
    companyDomain: null,
    country: null,
    region: asString(job.location),
    city: null,
    remoteType: job.remote === true ? "remote" : null,
    currency: null,
    salaryMin: null,
    salaryMax: null,
    salaryInterval: null,
    salarySource: null,
    publishedAt: parseArbeitnowCreatedAt(job.created_at),
    raw: {
      ...job,
      _intake: {
        source: ARBEITNOW_SOURCE_CODE,
        noticeVersion: ARBEITNOW_NOTICE_VERSION,
        fetchedAt,
        // Preserved rather than mapped: the tags the role filter matched on, the
        // employment types (often an empty array, but real data when present),
        // and the API's own terms string, which is where the link-back
        // requirement is stated.
        tags,
        jobTypes,
      },
    },
  };
}

export const arbeitnowIntakeAdapter: IntakeAdapter = {
  sourceCode: ARBEITNOW_SOURCE_CODE,
  displayName: "Arbeitnow (public job board API)",
  attribution:
    "Job data from Arbeitnow (https://www.arbeitnow.com), sourced from employer applicant tracking systems.",
  async fetchLiveJobs(query: IntakeQuery, fetchImpl: FetchImpl = fetch): Promise<IntakeFetchResult> {
    // No parameters at all: there is no key to send and no search to pass. The
    // only documented parameter is visa_sponsorship, which this adapter has no
    // candidate signal for and does not guess at.
    const response = await fetchImpl(ARBEITNOW_API_BASE, { headers: { accept: "application/json" } });

    if (!response.ok) {
      throw new ArbeitnowPayloadError(`HTTP ${response.status} from the Arbeitnow job board API`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ArbeitnowPayloadError("the response body was not JSON");
    }

    const data = (payload as { data?: unknown } | null)?.data;

    if (!Array.isArray(data)) {
      throw new ArbeitnowPayloadError("the response had no data array");
    }

    const jobs = data as ArbeitnowJob[];
    const fetchedAt = new Date().toISOString();

    // A single unreadable listing is skipped, not fatal.
    const mapped = jobs.map((job) => mapArbeitnowJob(job, fetchedAt));
    const usable = mapped.filter((vacancy): vacancy is DiscoveredVacancy => vacancy !== null);

    // LOCAL ROLE FILTER, because the API offers none. `skipped` deliberately
    // counts ONLY the unmappable rows: a posting that simply did not match the
    // candidate's roles was read and understood perfectly well, and folding the
    // two together would conflate "not for you" with "we could not parse it" and
    // make the received-vs-ingested gap unexplainable.
    const matching = query.keywords
      ? usable.filter((vacancy) =>
          matchesSelectedRoles(vacancy.rawTitle, toStringArray((vacancy.raw as { tags?: unknown }).tags), query.keywords),
        )
      : usable;

    return {
      // Sliced to the caller's limit, but never by fetching more: one page is
      // all this run asked for.
      vacancies: matching.slice(0, query.limit),
      // `data` IS the raw page, so this count is real rather than a proxy.
      received: jobs.length,
      skipped: mapped.length - usable.length,
    };
  },
};
