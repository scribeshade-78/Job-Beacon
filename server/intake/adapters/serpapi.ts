import type { DiscoveredVacancy, FetchImpl } from "../../ingestion/types.js";
import type { IntakeAdapter, IntakeFetchResult, IntakeQuery } from "./types.js";

/**
 * SerpApi (Google Jobs) — the fourth on-demand intake source.
 *
 * THE RESPONSE SHAPE HERE WAS READ FROM A REAL 200, NOT FROM THE DOCS. SerpApi's
 * documentation pages could not be read at all — both /google-jobs-api and
 * /google-jobs-results return a navigation sidebar large enough that the body is
 * truncated before the field list — so the shape below was captured from one
 * live google_jobs call (1 of the account's 100 monthly searches) and the
 * fixtures in the test file are that payload, trimmed.
 *
 * THAT VERIFICATION CHANGED THE MAPPING IN TWO PLACES, which is why it was not
 * skipped:
 *
 *   * `detected_extensions` DOES NOT EXIST in the response. The field is widely
 *     described as carrying salary, schedule_type and work_from_home; the real
 *     payload has no such object at all. Had the mapper been written from that
 *     description it would have read `detected_extensions.salary` and
 *     `detected_extensions.work_from_home` on every row and produced nulls from
 *     a field that was never sent — a silently empty column, not an error.
 *   * `extensions` carries RELATIVE human strings ("2 days ago", "Internship"),
 *     so there is NO absolute publication date anywhere in the payload.
 *     publishedAt is therefore null by construction, not by omission; turning
 *     "2 days ago" into a timestamp would invent a precision the source does not
 *     have and would drift on every read.
 *
 * QUOTA IS THE DESIGN CONSTRAINT. SerpApi's free tier is 100 searches per MONTH
 * — two orders of magnitude tighter than anything else in this fan-out (Jooble
 * is 500 lifetime, The Muse 500 hourly). One press of "Fetch latest jobs" must
 * therefore cost exactly ONE search, which is why this adapter never follows
 * `serpapi_pagination.next_page_token`: each page would be another search. A
 * google_jobs page holds about ten results, so the caller's `limit` is honoured
 * only up to what one page returned, and `received` reports the real count
 * rather than the requested one.
 */

export const SERPAPI_SOURCE_CODE = "serpapi";
export const SERPAPI_API_BASE = "https://serpapi.com/search.json";
export const SERPAPI_ENGINE = "google_jobs";

/** Which reading of SerpApi's terms these postings were ingested under. */
export const SERPAPI_NOTICE_VERSION = "serpapi-google-jobs-v1";

/**
 * India-first, matching the product's recorded stance. `location` narrows
 * further; these only set the geography signal when it does not.
 */
export const SERPAPI_DEFAULT_GL = "in";
export const SERPAPI_DEFAULT_HL = "en";

export class SerpApiPayloadError extends Error {
  constructor(detail: string) {
    super(`SerpApi returned a payload this adapter cannot read: ${detail}`);
    this.name = "SerpApiPayloadError";
  }
}

interface SerpApiApplyOption {
  title?: unknown;
  link?: unknown;
}

interface SerpApiJob {
  title?: unknown;
  job_title?: unknown;
  company_name?: unknown;
  location?: unknown;
  via?: unknown;
  share_link?: unknown;
  source_link?: unknown;
  description?: unknown;
  job_id?: unknown;
  extensions?: unknown;
  apply_options?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null)
    : [];
}

/**
 * "remote" only, never "hybrid" or "on_site" — the same refusal to assert a work
 * arrangement the source never stated that parseJoobleRemoteType and
 * parseTheMuseRemoteType make.
 *
 * SCANS THREE FIELDS, WHICH IS WIDER THAN THE JOOBLE RULE, AND THE LIVE PAYLOAD
 * IS WHY. Jooble puts the arrangement in its location string, so that adapter
 * reads only location. On the captured google_jobs row the location is a bare
 * "Vellore, Tamil Nadu" while the arrangement appears in the TITLE
 * ("Senior Data Engineer (India - Remote)") — a location-only rule would have
 * labelled that job non-remote and lost the only signal Google sent. `extensions`
 * is included because it is where Google puts its own structured labels. The
 * claim stays narrow either way: an explicit standalone "remote" token, else
 * nothing.
 */
export function parseSerpApiRemoteType(parts: readonly string[]): DiscoveredVacancy["remoteType"] {
  const joined = parts.join(" ").toLowerCase();

  return /\bremote\b/.test(joined) ? "remote" : null;
}

/**
 * Maps one google_jobs result onto the shared DiscoveredVacancy shape.
 *
 * FOUR DELIBERATE NON-MAPPINGS, each because the honest answer is "we do not
 * know" rather than a plausible guess:
 *
 * 1. country and city are NULL. `location` is free text — "Vellore, Tamil Nadu"
 *    is a city plus a state with no country in it, and other rows are a bare
 *    city or "Remote". The whole string goes to `region`, the closest true
 *    column, exactly as Remotive's candidate_required_location does.
 *
 * 2. companyDomain is NULL. `via` names the BOARD the posting was syndicated
 *    through ("BeBee"), not the employer and never the employer's own domain;
 *    deriving one from the company name is the "infer identity from a name" move
 *    the trust system scores against.
 *
 * 3. every salary column is NULL, and here that is not merely caution — the
 *    response carries no salary field at all (see detected_extensions above).
 *
 * 4. publishedAt is NULL, for the same reason: `extensions` holds "2 days ago".
 *
 * authoritativeUrl prefers `share_link` (Google's own canonical job URL, the
 * same link-back convention Jooble, Remotive and The Muse follow) and falls back
 * to `source_link` — the syndicating board's own page — when Google omits it.
 * Both are preserved in raw, along with `via`, `extensions` and `apply_options`,
 * so a future pass can reconsider the choice without another paid call.
 */
export function mapSerpApiJob(job: SerpApiJob, fetchedAt: string): DiscoveredVacancy | null {
  const jobId = job.job_id;
  const shareLink = asString(job.share_link);
  const sourceLink = asString(job.source_link);
  const authoritativeUrl = shareLink ?? sourceLink;
  const rawTitle = asString(job.title) ?? asString(job.job_title);
  const companyName = asString(job.company_name);

  // A posting missing any of these cannot be identified, linked to, or
  // attributed. Skipped rather than repaired, and counted so the caller can
  // explain a shortfall.
  if ((typeof jobId !== "number" && typeof jobId !== "string") || !authoritativeUrl || !rawTitle || !companyName) {
    return null;
  }

  const location = asString(job.location);
  const extensions = toStringArray(job.extensions);
  const via = asString(job.via);

  const applyOptions = Array.isArray(job.apply_options)
    ? (job.apply_options as SerpApiApplyOption[])
        .map((option) => ({ title: asString(option?.title), link: asString(option?.link) }))
        .filter((option) => option.link !== null)
    : [];

  return {
    sourceVacancyId: String(jobId),
    authoritativeUrl,
    rawTitle,
    companyName,
    companyDomain: null,
    country: null,
    region: location,
    city: null,
    remoteType: parseSerpApiRemoteType([location ?? "", ...extensions, rawTitle]),
    currency: null,
    salaryMin: null,
    salaryMax: null,
    salaryInterval: null,
    salarySource: null,
    publishedAt: null,
    raw: {
      ...job,
      _intake: {
        source: SERPAPI_SOURCE_CODE,
        noticeVersion: SERPAPI_NOTICE_VERSION,
        fetchedAt,
        // Preserved deliberately: which board actually carried the posting, the
        // relative freshness/type labels Google sent, and every apply target.
        // None of it fits a normalized column without inventing meaning, and all
        // of it is unrecoverable without spending another search.
        via,
        extensions,
        applyOptions,
        sourceLink,
        shareLink,
      },
    },
  };
}

/**
 * Reads the SerpApi key. Unlike The Muse this is MANDATORY: the endpoint rejects
 * an unauthenticated request with 401, so there is no public tier to fall back
 * to.
 *
 * THE KEY TRAVELS IN THE QUERY STRING (`?api_key=...`), which is the reason no
 * error message, log line or thrown Error from this adapter may contain a
 * request URL — the credential would be inside it. Errors name the base
 * endpoint only, which structurally cannot carry the key. Same reasoning as
 * Jooble's api_key_in_url_path, different parameter position.
 */
export function readSerpApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.SERPAPI_API_KEY?.trim();

  return key ? key : undefined;
}

export const serpapiIntakeAdapter: IntakeAdapter = {
  sourceCode: SERPAPI_SOURCE_CODE,
  displayName: "SerpApi (Google Jobs)",
  attribution: "Job data from Google Jobs via SerpApi (https://serpapi.com).",
  /**
   * ONE COMBINED QUERY, ONE SEARCH.
   *
   * The candidate's selected roles are joined into `q` and the confirmed
   * location is sent as `location`, mirroring how the Jooble adapter builds its
   * request. Both are required to be useful: google_jobs rejects a missing `q`,
   * and a search without a location returns Google's own default geography
   * rather than the candidate's.
   */
  async fetchLiveJobs(query: IntakeQuery, fetchImpl: FetchImpl = fetch): Promise<IntakeFetchResult> {
    const apiKey = readSerpApiKey();

    // Checked HERE, before any request, and thrown rather than returned as an
    // empty result: the fan-out turns a throw into a reported per-source skip
    // with this reason attached, whereas an empty result would tell the
    // candidate "Google has nothing for you" when Google was never asked.
    if (!apiKey) {
      throw new Error(
        "SerpApi intake requires SERPAPI_API_KEY — it is unset or blank. SerpApi has no " +
          "unauthenticated tier, so the request would be rejected with 401.",
      );
    }

    const keywords = (query.keywords ?? "").trim();
    if (!keywords) {
      throw new Error(
        "SerpApi intake requires keywords — select at least one target role. google_jobs " +
          "documents `q` as a required parameter, so there is nothing to search for without it.",
      );
    }

    const url = new URL(SERPAPI_API_BASE);
    url.searchParams.set("engine", SERPAPI_ENGINE);
    url.searchParams.set("q", keywords);
    url.searchParams.set("gl", SERPAPI_DEFAULT_GL);
    url.searchParams.set("hl", SERPAPI_DEFAULT_HL);

    const location = (query.location ?? "").trim();
    if (location) {
      url.searchParams.set("location", location);
    }

    // NO PAGINATION PARAMETER IS EVER SET. See the module comment: a second page
    // is a second search against 100 per month.
    url.searchParams.set("api_key", apiKey);

    const response = await fetchImpl(url.toString(), { headers: { accept: "application/json" } });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Fall through: a non-JSON body on a non-2xx is reported by status below.
    }

    const apiError = asString((payload as { error?: unknown } | null)?.error);

    // SerpApi reports authentication and quota problems BOTH as a non-2xx and,
    // in some cases, as a 200 carrying an `error` string — so both are checked
    // rather than trusting the status alone.
    if (apiError) {
      const lower = apiError.toLowerCase();

      // Quota and auth are the two that need different language, because one is
      // waited out and the other is fixed by an operator.
      if (lower.includes("run out of searches") || lower.includes("exceeded")) {
        throw new SerpApiPayloadError(
          `SerpApi quota exhausted for this account: ${apiError}`,
        );
      }

      if (response.status === 401 || lower.includes("invalid api key")) {
        throw new SerpApiPayloadError(
          "SerpApi rejected the configured SERPAPI_API_KEY as invalid (HTTP 401 from the search endpoint).",
        );
      }

      throw new SerpApiPayloadError(apiError);
    }

    if (!response.ok) {
      throw new SerpApiPayloadError(`HTTP ${response.status} from the SerpApi search endpoint`);
    }

    const results = (payload as { jobs_results?: unknown } | null)?.jobs_results;

    if (!Array.isArray(results)) {
      throw new SerpApiPayloadError("the response had no jobs_results array");
    }

    const jobs = results as SerpApiJob[];
    const fetchedAt = new Date().toISOString();

    // A single unreadable listing is skipped, not fatal: one malformed record in
    // a page of ten is not a reason to ingest none of them.
    const mapped = jobs.map((job) => mapSerpApiJob(job, fetchedAt));
    const vacancies = mapped.filter((vacancy): vacancy is DiscoveredVacancy => vacancy !== null);

    return {
      // Sliced to the caller's limit, but never by fetching more: one page is
      // all this run paid for.
      vacancies: vacancies.slice(0, query.limit),
      // Both counts are real here. `jobs_results` IS the raw page and the mapped
      // nulls ARE the skipped entries, so neither number is a proxy.
      received: jobs.length,
      skipped: mapped.length - vacancies.length,
    };
  },
};
