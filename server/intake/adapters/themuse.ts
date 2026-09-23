import type { DiscoveredVacancy, FetchImpl } from "../../ingestion/types.js";
import type { IntakeAdapter, IntakeFetchResult, IntakeQuery } from "./types.js";

/**
 * The Muse — the second public-browse intake source, alongside Remotive.
 *
 * EVERY FACT BELOW WAS VERIFIED AGAINST THE LIVE API, NOT RECALLED. The
 * published docs (https://www.themuse.com/developers/api/v2) give the endpoint,
 * the status codes, the rate limits and the pagination envelope, but their
 * "Jobs" section is followed by an enumerated value list long enough to truncate
 * the page before the job object is described. So the response shape, the
 * pagination base and the query parameters were all confirmed by calling the
 * API and reading what came back:
 *
 *   * GET https://www.themuse.com/api/public/jobs — the old api-v2.themuse.com
 *     host still works but redirects here, so this uses the current one.
 *   * `page` is REQUIRED and ZERO-BASED. Verified rather than assumed: page=0 and
 *     page=1 return different first results, so requesting page=1 as though it
 *     were the first page would silently drop the newest twenty listings.
 *   * `location` works and accepts free text — `location=India` narrowed `total`
 *     from 413,435 to 6,133, and `location=Bengaluru, India` also worked.
 *   * THERE IS NO KEYWORD PARAMETER. `q`, `keyword`, `search`, `query` and `name`
 *     were each tried and each left `total` at exactly 413,435, as did a
 *     deliberately bogus parameter — unknown parameters are ignored, not
 *     rejected, which is what makes those five results conclusive rather than
 *     merely suggestive. `category` and `level` DO work but require exact
 *     enumerated values (`category=Data Science` matched 2 jobs while
 *     `category=Data and Analytics` matched 18,556), and the docs' value list
 *     was truncated before those enums could be read. Mapping a candidate's role
 *     names onto them would therefore be a guess that silently returns the wrong
 *     market, so it is not attempted. See the limitation note on fetchLiveJobs.
 *   * Rate limits are HOURLY, not lifetime: 500 requests/hour unauthenticated and
 *     3,600 with an `api_key`. The response carries X-RateLimit-Remaining,
 *     -Limit and -Reset. Far more forgiving than Jooble's 500-per-key lifetime,
 *     which is why this adapter may safely spend ONE request per call and does
 *     not need Jooble's belt-and-braces page budget.
 */

export const THE_MUSE_SOURCE_CODE = "themuse";
export const THE_MUSE_API_BASE = "https://www.themuse.com/api/public/jobs";

/** Which reading of The Muse's terms these postings were ingested under. */
export const THE_MUSE_NOTICE_VERSION = "themuse-api-v1";

/**
 * The Muse serves a fixed 20 items per page. Declared rather than derived from
 * `items_per_page`, because that field is what the envelope REPORTS and this is
 * what the request is entitled to assume; a mismatch is a signal, not a value to
 * adapt to silently.
 */
export const THE_MUSE_PAGE_SIZE = 20;

export class TheMusePayloadError extends Error {
  constructor(detail: string) {
    super(`The Muse returned a payload this adapter cannot read: ${detail}`);
    this.name = "TheMusePayloadError";
  }
}

interface TheMuseLocation {
  name?: unknown;
}

interface TheMuseJob {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  publication_date?: unknown;
  locations?: unknown;
  categories?: unknown;
  levels?: unknown;
  refs?: unknown;
  company?: unknown;
  contents?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * `publication_date` arrives as ISO 8601 in UTC — confirmed by reading the RAW
 * response body, e.g. "2025-03-06T00:50:37Z".
 *
 * HOW THIS WAS ALMOST GOT WRONG, recorded so nobody "fixes" it back. An earlier
 * version of this adapter parsed the field as "MM/DD/YYYY HH:mm:ss" and carried
 * a comment claiming that format had been verified live. It had not: the
 * verification had been done through PowerShell's Invoke-RestMethod, which
 * converts ISO 8601 JSON strings into [datetime] objects while parsing, so what
 * was read back was PowerShell's US-style RENDERING of the value rather than the
 * bytes on the wire. Every Muse vacancy therefore carried publishedAt = null,
 * silently, and the unit tests passed because their fixture had been written
 * from the same misreading. The lesson is in the method, not just the fix: a
 * third-party format must be checked against the raw body, never a client
 * library's parsed view of it.
 *
 * Still returns null rather than a fabricated date for anything that does not
 * match — "an absent value is recoverable, a wrong one is not". A UTC offset is
 * accepted alongside Z so a future change to offset form does not silently null
 * every row, but the shape must be ISO 8601 either way.
 */
export function parseTheMusePublicationDate(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    return null;
  }

  const parsed = new Date(text);

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Only ever "remote" or null, never "hybrid" or "on_site".
 *
 * Same stance as parseJoobleRemoteType: The Muse's `locations` entries are place
 * names ("Dearborn, MI") with no work-arrangement field anywhere in the payload,
 * so the single thing that CAN be read is an explicit remote marker. A bare
 * place name says nothing about whether the role is on-site — inferring
 * "on-site" from it would be inventing a fact the source never stated, and
 * remote_type is a column the candidate-facing filters actually query.
 */
export function parseTheMuseRemoteType(locationNames: readonly string[]): DiscoveredVacancy["remoteType"] {
  const joined = locationNames.join(" ").toLowerCase();

  return /\bremote\b/.test(joined) ? "remote" : null;
}

function locationNames(job: TheMuseJob): string[] {
  if (!Array.isArray(job.locations)) {
    return [];
  }

  return job.locations
    .map((entry) => asString((entry as TheMuseLocation | null)?.name))
    .filter((name): name is string => name !== null);
}

/**
 * Maps one Muse posting onto the shared DiscoveredVacancy shape.
 *
 * THREE DELIBERATE NON-MAPPINGS, each because the honest answer is "we do not
 * know" rather than a plausible guess:
 *
 * 1. country is NULL. `locations` holds free-text place names — "Dearborn, MI",
 *    "London", "Remote" — which are not countries and are frequently not even
 *    city/country pairs. The first entry is carried verbatim in `region`, the
 *    closest true column, exactly as Remotive's candidate_required_location is.
 *
 * 2. city is NULL. "Dearborn, MI" is a city plus a state, and there is no
 *    reliable delimiter contract across the corpus to split on — some entries are
 *    a bare country, some are "Flexible / Remote". Splitting would put a state
 *    code in a city column for some rows and a country in it for others.
 *
 * 3. salary fields are NULL. The public jobs endpoint carries no salary on the
 *    rows observed, and a wrong number in a salary column is worse for a
 *    candidate than an empty one.
 *
 * companyDomain is also NULL: The Muse publishes the employer's Muse profile,
 * never the employer's own domain, and deriving one from the company name is the
 * "infer identity from a name" move the trust system scores against.
 */
export function mapTheMuseJob(job: TheMuseJob, fetchedAt: string): DiscoveredVacancy | null {
  const id = job.id;
  const refs = (job.refs ?? {}) as { landing_page?: unknown };
  const authoritativeUrl = asString(refs.landing_page);
  const rawTitle = asString(job.name);
  const company = (job.company ?? {}) as { name?: unknown; short_name?: unknown };
  const companyName = asString(company.name);

  // A posting missing any of these cannot be identified, linked to, or
  // attributed. Skipped rather than repaired — the count is reported so the
  // caller can explain why fewer came back than the source held.
  if ((typeof id !== "number" && typeof id !== "string") || !authoritativeUrl || !rawTitle || !companyName) {
    return null;
  }

  const names = locationNames(job);
  const categories = Array.isArray(job.categories)
    ? job.categories
        .map((entry) => asString((entry as TheMuseLocation | null)?.name))
        .filter((name): name is string => name !== null)
    : [];

  return {
    sourceVacancyId: String(id),
    // The Muse's OWN landing page, never an employer ATS link lifted out of the
    // description: it is the link-back the source expects, and it is the honest
    // provenance — this repository did not fetch the posting from the employer.
    authoritativeUrl,
    rawTitle,
    companyName,
    companyDomain: null,
    country: null,
    region: names[0] ?? null,
    city: null,
    remoteType: parseTheMuseRemoteType(names),
    currency: null,
    salaryMin: null,
    salaryMax: null,
    salaryInterval: null,
    salarySource: null,
    publishedAt: parseTheMusePublicationDate(job.publication_date),
    raw: {
      ...job,
      _intake: {
        source: THE_MUSE_SOURCE_CODE,
        noticeVersion: THE_MUSE_NOTICE_VERSION,
        fetchedAt,
        // Kept out of the normalized columns above but preserved here: the
        // categories and levels are the only structured signal The Muse offers
        // about what a role is, and throwing them away would make a future
        // role-matching pass re-fetch a payload we already paid for.
        museCategories: categories,
        museLevels: Array.isArray(job.levels)
          ? job.levels
              .map((entry) => asString((entry as TheMuseLocation | null)?.name))
              .filter((name): name is string => name !== null)
          : [],
      },
    },
  };
}

/**
 * Reads the optional API key. Absent is legitimate — the endpoint is public and
 * unauthenticated callers get 500 requests/hour — so this never throws, unlike
 * Jooble's credential reader where a key is mandatory.
 *
 * NOT a secret in the Jooble sense: The Muse takes its key as an ordinary query
 * parameter, and this adapter still never puts a request URL into a message,
 * because that URL is where the key would be. Errors name only the base
 * endpoint, which structurally cannot carry a credential.
 */
export function readTheMuseApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.THE_MUSE_API_KEY?.trim();

  return key ? key : undefined;
}

export const theMuseIntakeAdapter: IntakeAdapter = {
  sourceCode: THE_MUSE_SOURCE_CODE,
  displayName: "The Muse (public jobs API)",
  attribution: "Job data from The Muse (https://www.themuse.com).",
  /**
   * WHERE THE CANDIDATE'S ROLES GO, AND WHERE THEY CANNOT.
   *
   * This adapter reads the confirmed location fact, exactly as the Jooble
   * adapter does, and sends it as The Muse's `location` parameter.
   *
   * It does NOT send the selected roles, and that is a property of the API
   * rather than an omission: The Muse has no keyword search parameter (verified
   * above), and its only text-ish filters are `category` and `level`, which
   * accept exact enumerated values that the documentation truncates before
   * listing. Sending a role name as a `category` is the failure mode worth
   * naming — `category=Data Science` matched 2 jobs against 413,435 while
   * `category=Data and Analytics` matched 18,556 — so a near-miss enum does not
   * error, it quietly answers a different question. Role-based narrowing for
   * this source needs the real enum, which is a deliberate follow-up rather than
   * something to guess at here.
   */
  async fetchLiveJobs(query: IntakeQuery, fetchImpl: FetchImpl = fetch): Promise<IntakeFetchResult> {
    const url = new URL(THE_MUSE_API_BASE);
    const location = (query.location ?? "").trim();

    // Zero-based, verified: page=1 would skip the first twenty listings.
    url.searchParams.set("page", "0");

    if (location) {
      url.searchParams.set("location", location);
    }

    const apiKey = readTheMuseApiKey();
    if (apiKey) {
      url.searchParams.set("api_key", apiKey);
    }

    const response = await fetchImpl(url.toString(), { headers: { accept: "application/json" } });

    if (!response.ok) {
      // 403 is documented as the rate-limit status. Read the headers when they
      // are present so the reason is actionable rather than a bare "403" —
      // an hourly budget is waited out, not debugged.
      if (response.status === 403) {
        const remaining = response.headers?.get?.("x-ratelimit-remaining") ?? null;
        const reset = response.headers?.get?.("x-ratelimit-reset") ?? null;

        throw new TheMusePayloadError(
          `HTTP 403 from the Muse jobs endpoint, which its documentation names as the rate-limit status` +
            (remaining ? ` (remaining=${remaining}` : "") +
            (reset ? `, resets in ${reset}s)` : remaining ? ")" : ""),
        );
      }

      // The API's own error body is { code, error } and says more than the
      // status alone, so it is read when it parses.
      let detail = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: unknown; code?: unknown };
        if (typeof body.error === "string" && body.error.trim()) {
          detail = `HTTP ${response.status}: ${body.error.trim()}`;
        }
      } catch {
        // A non-JSON error body is not itself worth failing differently over.
      }

      throw new TheMusePayloadError(detail);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TheMusePayloadError("the response body was not JSON");
    }

    const results = (payload as { results?: unknown } | null)?.results;

    if (!Array.isArray(results)) {
      throw new TheMusePayloadError("the response had no results array");
    }

    const jobs = results as TheMuseJob[];
    const fetchedAt = new Date().toISOString();

    // A single unreadable listing is skipped, not fatal: one malformed record in
    // a page of twenty is not a reason to ingest none of them.
    const mapped = jobs.map((job) => mapTheMuseJob(job, fetchedAt));
    const vacancies = mapped.filter((vacancy): vacancy is DiscoveredVacancy => vacancy !== null);

    return {
      vacancies: vacancies.slice(0, query.limit),
      // THE MUSE GIVES BOTH COUNTS HONESTLY, unlike Jooble and Adzuna, whose
      // ingestion adapters return a bare array and force their wrappers to
      // report a usable-listing count as though it were the pre-filter one.
      // Here `results` IS the raw page and the mapped nulls ARE the skipped
      // entries, so neither number is guessed.
      received: jobs.length,
      skipped: mapped.length - vacancies.length,
    };
  },
};
