import type { DiscoveredVacancy, FetchImpl } from "../types.js";
import type { DiscoveryAdapter, DiscoveryAdapterConfig } from "./types.js";

/**
 * Jooble REST API (PRD §10.2 aggregator tier — same class as Adzuna/USAJOBS,
 * not an employer-hosted ATS board).
 *
 * VERIFICATION NOTE: field names, request parameters and status codes below
 * are taken from Jooble's own help centre, fetched and read directly (not
 * invented, not from secondary sources):
 *   - REST API documentation (request params, response fields, 200/403/404):
 *     https://help.jooble.org/en/support/solutions/articles/60001448238-rest-api-documentation
 *   - How to connect to the Jooble REST API (registration, regional domains):
 *     https://help.jooble.org/en/support/solutions/articles/60000922689-how-to-connect-to-the-jooble-rest-api
 *
 * ONE KNOWN DOC INCONSISTENCY, resolved deliberately: the parameter table
 * types `page`/`ResultOnPage`/`SearchMode` as integer and `companysearch`
 * as boolean, but the only concrete wire example Jooble publishes sends all
 * four as JSON strings ({"companysearch": "false"}). This adapter follows the
 * wire example, because a worked example is stronger evidence of what the
 * server actually accepts than a type column. See buildRequestBody().
 *
 * THREE PROVIDER CONSTRAINTS THAT SHAPE THIS ADAPTER:
 *
 * 1. THE KEY IS IN THE URL PATH. Auth is POST https://jooble.org/api/{key} —
 *    there is no Authorization header. The credential is therefore part of
 *    every request URL by construction, so any log line, thrown error, HTTP
 *    trace, APM/Sentry span, or n8n execution record that captures the URL
 *    captures the secret. Every error this module throws is built from
 *    REDACTED_JOOBLE_ENDPOINT, never from the real URL, and the raw provider
 *    error text is never interpolated into a message.
 *
 * 2. THE FREE PLAN IS A LIFETIME QUOTA OF 500 REQUESTS PER KEY — not monthly,
 *    not daily. Every design choice here exists to protect that budget: a
 *    retry is not free, it is a request spent; pagination is capped and
 *    hard-guarded rather than "loop until exhausted"; and config errors are
 *    rejected in validateConfig() before any request is made. Note that
 *    ResultOnPage is free — one request returns many jobs — so this adapter
 *    prefers a large page size over many small pages.
 *
 * 3. THE KEY IS COUNTRY-SCOPED. Each Jooble domain issues its own key and
 *    returns only that country's listings (jooble.org => US,
 *    uk.jooble.org => UK, de.jooble.org => DE, ...). The response body has no
 *    country field at all, so a normalized vacancy's `country` can only come
 *    from target config, never from the payload. A key from the wrong domain
 *    surfaces as HTTP 403, not as empty results.
 *
 * targetKey is a stable operator-chosen label for a saved search (the same
 * convention USAJOBS uses) — Jooble's API is keyword/location driven and
 * consumes nothing resembling a target identifier.
 */

/** Real endpoint form. Embeds the credential — never log, throw, or persist this. */
const JOOBLE_API_BASE = "https://jooble.org/api/";

/**
 * The only form of the Jooble endpoint safe to log, throw, or attach to an
 * error/span. Use this instead of the real URL anywhere a URL is recorded.
 */
export const REDACTED_JOOBLE_ENDPOINT = "https://jooble.org/api/{JOOBLE_API_KEY}";

/** Jooble documents exactly these radius values (km). Anything else is a config error. */
const ALLOWED_RADII: readonly string[] = ["0", "4", "8", "16", "26", "40", "80"];

/**
 * Default and self-imposed ceiling for ResultOnPage. Jooble documents the
 * parameter but not its maximum, so 100 is this adapter's own conservative
 * cap rather than a provider-published limit — raise it only after observing
 * a real response. It doubles as the page-size default because a bigger page
 * costs the same single request.
 */
const DEFAULT_RESULTS_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 3;
/** Absolute ceiling — a bad config row must not be able to burn the lifetime quota. */
const HARD_MAX_PAGES = 10;
/**
 * Jooble publishes no numeric rate limit. This is a politeness floor between
 * sequential page requests, not a provider-documented contract; the real
 * ceiling is the lifetime request quota.
 */
const DEFAULT_MIN_INTERVAL_MS = 1_100;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_REQUESTS_PER_RUN = 6;
const HARD_MAX_REQUESTS_PER_RUN = 20;
const MAX_BACKOFF_MS = 30_000;

/**
 * Only genuinely transient failures are retried. Notably absent: 403 and 404.
 * A retry cannot fix a wrong-domain or malformed key — it would only spend
 * two more requests against the lifetime quota to fail identically.
 */
const RETRYABLE_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

export interface JoobleTargetConfig extends DiscoveryAdapterConfig {
  /** Required by Jooble (comma-separated titles/keywords). */
  keywords?: string;
  /** Required by Jooble (city, region, or country name). */
  location?: string;
  /** One of ALLOWED_RADII (km). Omitted from the request when unset. */
  radius?: string;
  /** Minimum salary threshold, as Jooble expects it. */
  salary?: number;
  /** true = match keywords against company names; false = against titles/descriptions. */
  companySearch?: boolean;
  /** Jobs per page. One request per page, so a larger page size is strictly cheaper. */
  resultsPerPage?: number;
  /** Pages to request per run, clamped to HARD_MAX_PAGES. */
  maxPages?: number;
  /** Jooble's search algorithm mode; passed through unchanged. */
  searchMode?: number;
  /**
   * ISO country code for the normalized vacancies (e.g. "US"). Jooble's
   * response carries no country field, so this is the only source for it.
   * Should match the domain the key was issued for. Left null when unset
   * rather than inferred from keywords/location text.
   */
  country?: string;
  /** Milliseconds between sequential requests. Defaults to DEFAULT_MIN_INTERVAL_MS. */
  minIntervalMs?: number;
  /** Retries per request after the first attempt. Defaults to DEFAULT_MAX_RETRIES. */
  maxRetries?: number;
  /** Base exponential backoff. 0 is honoured, which keeps tests instant. */
  retryBaseDelayMs?: number;
  /** Hard cap on requests this run may spend, retries included. */
  maxRequestsPerRun?: number;
}

export interface JoobleCredentials {
  apiKey: string;
}

/**
 * Shape of one entry in the documented `jobs` array. Every field is optional
 * here because this is untrusted remote JSON: the adapter must tolerate a
 * provider omitting a field without throwing a TypeError mid-page.
 */
interface JoobleJob {
  id?: number | string;
  title?: string;
  location?: string;
  snippet?: string;
  salary?: string;
  source?: string;
  type?: string;
  link?: string;
  company?: string;
  updated?: string;
}

interface JoobleSearchResponse {
  totalCount?: number;
  jobs?: JoobleJob[];
}

/**
 * Values that mean "the operator has not filled this in yet". Rejected loudly
 * at use time rather than sent as a request that would 403 and cost quota.
 * Matched case-insensitively. The rejected value is never echoed back.
 */
const PLACEHOLDER_KEYS: readonly string[] = [
  "your_key_here",
  "your-key-here",
  "changeme",
  "replace_me",
  "<your_key_here>",
  "xxx",
  "todo",
];

/**
 * Reads and validates the Jooble credential.
 *
 * Follows this repo's lazy-env-read convention (same as adzuna.ts /
 * usajobs.ts / openaiClient.ts): process.env is read at call time, not at
 * module load, so importing this module never requires the variable to exist.
 *
 * @throws Error naming JOOBLE_API_KEY when it is unset, blank, or still a
 * placeholder. The thrown message never contains the variable's value.
 */
export function readJoobleCredentials(env: NodeJS.ProcessEnv = process.env): JoobleCredentials {
  const raw = env.JOOBLE_API_KEY;
  const apiKey = typeof raw === "string" ? raw.trim() : "";

  if (!apiKey) {
    throw new Error(
      // The registration page is deliberately described rather than written as a
      // URL: it shares the /api/ path prefix with the credential-bearing
      // endpoint, so redactJoobleEndpoint() would mangle it. See
      // docs/JOOBLE_INTEGRATION.md §1.1 for the per-country registration table.
      "Jooble discovery requires JOOBLE_API_KEY — it is unset or blank. Register on the Jooble " +
        "API portal for your target country (the /api/about page on that country's Jooble domain) " +
        "and set the key in the environment. Never commit or log the value.",
    );
  }

  if (PLACEHOLDER_KEYS.includes(apiKey.toLowerCase())) {
    throw new Error(
      "Jooble discovery requires a real JOOBLE_API_KEY — the configured value is still the " +
        ".env.example placeholder. Replace it with the key from your country's Jooble API portal.",
    );
  }

  return { apiKey };
}

/**
 * Replaces the credential-bearing path segment of a Jooble URL with the
 * placeholder form, so a URL that originated outside this module (a fetch
 * error, an HTTP client's error message, an n8n node log, a Sentry breadcrumb)
 * can be logged safely.
 *
 * Deliberately over-redacts: any jooble.org URL under /api/ is rewritten,
 * including the public registration page (/api/about). Redirecting a public
 * URL to the placeholder form is a cosmetic loss; failing to redact a real key
 * is a credential leak, so this helper always errs toward the safe direction.
 * Do not narrow the pattern to "fix" the cosmetic case.
 *
 * Safe on any string: a non-Jooble URL is returned unchanged.
 */
export function redactJoobleEndpoint(value: string): string {
  if (typeof value !== "string") {
    return REDACTED_JOOBLE_ENDPOINT;
  }

  // Matches https://<optional regional subdomain.>jooble.org/api/<secret> and
  // keeps only the host. Everything from the path onward is consumed —
  // including any query string or fragment — because the credential occupies
  // the path and a partially-redacted URL is still a URL worth not logging.
  return value.replace(
    /https?:\/\/([a-z0-9-]*(?:\.)?jooble\.org)\/api\/[^\s"']*/gi,
    (_match, host: string) => "https://" + host + "/api/{JOOBLE_API_KEY}",
  );
}

export interface ParsedJoobleSalary {
  min: number | null;
  max: number | null;
  currency: string | null;
}

/**
 * Jooble documents `salary` as a formatted STRING, e.g. "17,600 UAH" or
 * "{min} - {max} {currency}" — never as structured numbers. It also never
 * states the pay period, which is why this parser returns no interval: a
 * guessed "year" would silently corrupt salary comparisons downstream.
 *
 * Anything unparseable yields nulls rather than a guess. Where two amounts
 * are present the smaller is min and the larger is max, regardless of the
 * order Jooble printed them in.
 */
export function parseJoobleSalary(salary: unknown): ParsedJoobleSalary {
  const empty: ParsedJoobleSalary = { min: null, max: null, currency: null };

  if (typeof salary !== "string") {
    return empty;
  }

  const text = salary.trim();
  if (!text) {
    return empty;
  }

  const currency = detectCurrency(text);
  const tokens = text.match(/\d[\d.,]*/g) ?? [];
  const amounts = tokens
    .map(parseAmountToken)
    .filter((amount): amount is number => amount !== null);

  if (amounts.length === 0) {
    return { min: null, max: null, currency };
  }

  if (amounts.length === 1) {
    // A single figure is the whole disclosed amount — recorded as both bounds
    // rather than leaving max null, which downstream filters read as "no
    // ceiling known". Jooble gives no lower/upper distinction for one number.
    return { min: amounts[0], max: amounts[0], currency };
  }

  return { min: Math.min(...amounts), max: Math.max(...amounts), currency };
}

/**
 * ISO-4217 codes Jooble's markets actually use. A whitelist (rather than
 * "any 3-letter word") is what keeps "1,000 per month" from parsing "per" /
 * "mon" as a currency.
 */
const CURRENCY_CODES: readonly string[] = [
  "USD", "EUR", "GBP", "UAH", "PLN", "CZK", "RON", "HUF", "BGN", "HRK",
  "RSD", "RUB", "BYN", "KZT", "UZS", "TRY", "ILS", "INR", "IDR", "MYR",
  "PHP", "SGD", "THB", "VND", "JPY", "CNY", "HKD", "TWD", "KRW", "AUD",
  "NZD", "CAD", "BRL", "MXN", "ZAR", "NGN", "KES", "EGP", "SAR", "AED",
  "QAR", "PKR", "BDT", "LKR", "NPR",
];

/** Symbols are checked before codes because they are unambiguous. */
const CURRENCY_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ["$", "USD"],
  ["\u20ac", "EUR"],
  ["\u00a3", "GBP"],
  ["\u20b4", "UAH"],
  ["\u20bd", "RUB"],
  ["\u20ba", "TRY"],
  ["\u20b9", "INR"],
  ["\u00a5", "JPY"],
  ["z\u0142", "PLN"],
  ["K\u010d", "CZK"],
];

function detectCurrency(text: string): string | null {
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (text.includes(symbol)) {
      return code;
    }
  }

  for (const word of text.match(/[A-Za-z]{3}/g) ?? []) {
    const upper = word.toUpperCase();
    if (CURRENCY_CODES.includes(upper)) {
      return upper;
    }
  }

  return null;
}

/**
 * Parses one number token whose separator convention is unknown: "17,600"
 * may be seventeen thousand six hundred or seventeen point six, and Jooble
 * publishes no locale. The heuristic is deliberately narrow — a separator is
 * read as a thousands separator only when it groups digits in exact threes,
 * which is what "17,600" and "1.234.567" do and what "5,5" does not.
 */
function parseAmountToken(token: string): number | null {
  const trimmed = token.trim();
  if (!/^\d/.test(trimmed)) {
    return null;
  }

  const hasComma = trimmed.includes(",");
  const hasDot = trimmed.includes(".");
  let normalized: string;

  if (hasComma && hasDot) {
    // Both present: whichever appears last is the decimal separator.
    normalized =
      trimmed.lastIndexOf(",") > trimmed.lastIndexOf(".")
        ? trimmed.replace(/\./g, "").replace(/,/g, ".")
        : trimmed.replace(/,/g, "");
  } else if (hasComma) {
    normalized = /^\d{1,3}(,\d{3})+$/.test(trimmed)
      ? trimmed.replace(/,/g, "")
      : trimmed.replace(/,/g, ".");
  } else if (hasDot) {
    normalized = /^\d{1,3}(\.\d{3})+$/.test(trimmed)
      ? trimmed.replace(/\./g, "")
      : trimmed;
  } else {
    normalized = trimmed;
  }

  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/**
 * Maps one Jooble job to this repo's DiscoveredVacancy.
 *
 * Returns null for a job with no stable id or no destination link — those two
 * are structural (dedup keys and the user-facing link) and cannot be
 * defaulted. Everything else is either mapped or explicitly left null; the
 * fields Jooble returns that DiscoveredVacancy has no column for
 * (`snippet`, `type`, `source`) survive verbatim in `raw`, which is stored
 * in vacancy_versions and read back by the JD extractor.
 *
 * @param job - One entry from the documented `jobs` array.
 * @param country - ISO country code from target config, or null. Jooble's
 *   payload has no country field to fall back on.
 */
export function normalizeJoobleJob(job: JoobleJob, country: string | null): DiscoveredVacancy | null {
  const id = job.id;
  const link = typeof job.link === "string" ? job.link.trim() : "";

  if (id === undefined || id === null || String(id).trim() === "" || !link) {
    return null;
  }

  const salary = parseJoobleSalary(job.salary);
  const hasSalary = salary.min !== null || salary.max !== null;

  return {
    sourceVacancyId: String(id).trim(),
    authoritativeUrl: link,
    rawTitle: typeof job.title === "string" && job.title.trim() ? job.title.trim() : "Untitled",
    companyName: typeof job.company === "string" && job.company.trim() ? job.company.trim() : "Unknown",
    // Jooble returns no company domain, and the listing link points at Jooble
    // itself (or the upstream source), never an employer domain — so there is
    // nothing here to populate this without guessing.
    companyDomain: null,
    country,
    // `location` is one freeform string ("Kyiv", "London, UK", "Remote") with
    // no documented structure. Same ambiguity Adzuna/USAJOBS have — not
    // decomposed into region/city without guessing.
    region: null,
    city: null,
    // Jooble's documented fields include no remote/hybrid indicator. `type` is
    // an employment type (Full-time/Part-time), not a work arrangement, so it
    // is not mapped here.
    remoteType: null,
    currency: salary.currency,
    salaryMin: salary.min,
    salaryMax: salary.max,
    // Jooble never states the pay period — see parseJoobleSalary.
    salaryInterval: null,
    // Jooble's `salary` is a formatted display string of undocumented
    // provenance (which may be an aggregation or an estimate for some
    // listings). Same conservative call adzuna.ts makes for the same reason:
    // "estimated" rather than asserting employer disclosure.
    salarySource: hasSalary ? "estimated" : null,
    // ISO-ish timestamp, passed through verbatim. Jooble emits 7 fractional
    // digits ("2023-09-15T12:55:35.3870000"); Postgres timestamptz accepts
    // that, and rewriting a provider timestamp would be a silent data edit.
    publishedAt: typeof job.updated === "string" && job.updated.trim() ? job.updated.trim() : null,
    raw: job,
  };
}

/** Bounded, quota-aware shared state for one discovery run. */
interface RunState {
  used: number;
}

interface Pacer {
  lastRequestAt: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Waits out the remainder of the inter-request interval. Applying this before
 * every attempt (retries included) is what keeps a retry storm from also
 * being a burst.
 */
async function pace(pacer: Pacer, minIntervalMs: number): Promise<void> {
  if (pacer.lastRequestAt === 0) {
    return;
  }

  const elapsed = Date.now() - pacer.lastRequestAt;
  const waitMs = minIntervalMs - elapsed;

  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

/** Parses Retry-After in either documented HTTP form (delta-seconds or HTTP-date). */
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) {
    return null;
  }

  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return null;
}

/** Internal signal: the failure is transient and worth one more request. */
class RetryableJoobleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableJoobleError";
  }
}

/** Internal signal: the failure is terminal (bad key, bad config, bad payload). */
class FatalJoobleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalJoobleError";
  }
}

/**
 * Builds the documented request body. See the module doc comment on the
 * string-vs-integer discrepancy: values are sent as strings to match Jooble's
 * own worked example.
 */
function buildRequestBody(
  config: JoobleTargetConfig,
  page: number,
  resultsPerPage: number,
): Record<string, string> {
  const body: Record<string, string> = {
    keywords: config.keywords ?? "",
    location: config.location ?? "",
    page: String(page),
    // Sent as "true"/"false" per Jooble's example payload.
    companysearch: config.companySearch === true ? "true" : "false",
  };

  if (config.radius !== undefined) {
    body.radius = String(config.radius);
  }
  if (config.salary !== undefined) {
    body.salary = String(config.salary);
  }
  if (config.searchMode !== undefined) {
    body.SearchMode = String(config.searchMode);
  }

  // ResultOnPage is intentionally sent even when it equals the default: one
  // request per page means page size is the cheapest lever on quota.
  body.ResultOnPage = String(resultsPerPage);

  return body;
}

/**
 * Performs one search request with bounded retries.
 *
 * Every attempt — including each retry — consumes the key's lifetime quota,
 * so this counts attempts, not logical requests, and the caller's budget
 * guard sees the true spend. Error messages are built exclusively from
 * REDACTED_JOOBLE_ENDPOINT.
 */
async function postJoobleSearch(
  endpoint: string,
  body: Record<string, string>,
  options: {
    fetchImpl: FetchImpl;
    pacer: Pacer;
    minIntervalMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
    runState: RunState;
    maxRequestsPerRun: number;
  },
): Promise<JoobleSearchResponse> {
  const { fetchImpl, pacer, minIntervalMs, maxRetries, retryBaseDelayMs, runState, maxRequestsPerRun } =
    options;

  let lastError: Error = new FatalJoobleError("Jooble request was never attempted.");

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (runState.used >= maxRequestsPerRun) {
      throw new FatalJoobleError(
        "Jooble request budget exhausted (" +
          maxRequestsPerRun +
          " requests) before the search could complete. Raise maxRequestsPerRun deliberately — " +
          "each request is spent against the key's lifetime quota of 500.",
      );
    }

    if (attempt > 0) {
      const backoff = clamp(retryBaseDelayMs * 2 ** (attempt - 1), 0, MAX_BACKOFF_MS);
      // Jitter spreads retries if several workers share a key; 0 base stays 0.
      const jitter = backoff > 0 ? Math.floor(Math.random() * (backoff / 2 + 1)) : 0;
      await sleep(backoff + jitter);
    }

    await pace(pacer, minIntervalMs);
    pacer.lastRequestAt = Date.now();
    runState.used += 1;

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // A transport failure's own message may embed the request URL (and so
      // the key), and may vary by fetch implementation — so it is classified
      // and discarded, never interpolated.
      lastError = new RetryableJoobleError(
        "Jooble request failed at the transport layer (no HTTP response) for " +
          REDACTED_JOOBLE_ENDPOINT +
          ". Cause suppressed to avoid leaking the credential embedded in the request URL.",
      );
      void error;
      continue;
    }

    if (response.ok) {
      try {
        return (await response.json()) as JoobleSearchResponse;
      } catch {
        throw new FatalJoobleError(
          "Jooble returned HTTP " +
            response.status +
            " with a body that is not valid JSON for " +
            REDACTED_JOOBLE_ENDPOINT +
            ".",
        );
      }
    }

    const status = response.status;

    if (status === 403) {
      throw new FatalJoobleError(
        "Jooble returned HTTP 403 (access denied) for " +
          REDACTED_JOOBLE_ENDPOINT +
          ". This is a credential problem, not a transient one, so it is not retried: the key is " +
          "missing, malformed, or was issued for a different country domain than the one being " +
          "queried. Verify JOOBLE_API_KEY against the portal for the target country.",
      );
    }

    if (status === 404) {
      throw new FatalJoobleError(
        "Jooble returned HTTP 404 for " +
          REDACTED_JOOBLE_ENDPOINT +
          ". The endpoint path was not recognised — the key is most likely truncated or contains " +
          "characters that were altered in transit. Rotate and re-set JOOBLE_API_KEY.",
      );
    }

    if (RETRYABLE_STATUSES.includes(status)) {
      const retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after") ?? null);
      const isLastAttempt = attempt >= maxRetries;

      if (isLastAttempt) {
        throw new FatalJoobleError(
          "Jooble returned HTTP " +
            status +
            " for " +
            REDACTED_JOOBLE_ENDPOINT +
            " and the retry budget (" +
            maxRetries +
            ") is exhausted. The job-level retry in the ingestion worker will schedule a later attempt.",
        );
      }

      lastError = new RetryableJoobleError(
        "Jooble returned transient HTTP " + status + " for " + REDACTED_JOOBLE_ENDPOINT + ".",
      );

      // A server-requested wait longer than our ceiling is honoured only up
      // to that ceiling; the job-level retry is the backstop beyond it.
      if (retryAfterMs !== null && retryAfterMs > 0) {
        await sleep(clamp(retryAfterMs, 0, MAX_BACKOFF_MS));
      }

      continue;
    }

    // Any other non-2xx (400/401/422/...) is a request-shape or config
    // problem. Retrying would spend quota to fail identically.
    throw new FatalJoobleError(
      "Jooble returned HTTP " + status + " for " + REDACTED_JOOBLE_ENDPOINT + " (not retryable). " +
        "Check the target config: keywords and location are both required by Jooble, and radius " +
        "must be one of " + ALLOWED_RADII.join(", ") + ".",
    );
  }

  throw lastError;
}

/**
 * Discovers vacancies from Jooble for one saved search.
 *
 * @param targetConfig - Saved-search config (keywords/location required).
 * @param credentials - The country-scoped API key.
 * @param fetchImpl - Injected fetch, for tests.
 * @throws Error with a redacted message on credential, transport, or HTTP
 *   failure. The thrown message never contains the API key.
 */
export async function discoverJooble(
  targetConfig: JoobleTargetConfig,
  credentials: JoobleCredentials,
  fetchImpl: FetchImpl = fetch,
): Promise<DiscoveredVacancy[]> {
  if (!credentials.apiKey || !credentials.apiKey.trim()) {
    throw new Error(
      "Jooble discovery requires an API key — none configured. Set JOOBLE_API_KEY in the " +
        "environment (server/worker-only; never a VITE_ variable).",
    );
  }

  const keywords = (targetConfig.keywords ?? "").trim();
  const location = (targetConfig.location ?? "").trim();

  if (!keywords || !location) {
    throw new Error(
      "Jooble discovery requires both keywords and location — Jooble documents both as required " +
        "request parameters and rejects a search missing either.",
    );
  }

  const resultsPerPage = clamp(
    Math.trunc(targetConfig.resultsPerPage ?? DEFAULT_RESULTS_PER_PAGE),
    1,
    DEFAULT_RESULTS_PER_PAGE,
  );
  const maxPages = clamp(Math.trunc(targetConfig.maxPages ?? DEFAULT_MAX_PAGES), 1, HARD_MAX_PAGES);
  const minIntervalMs = clamp(
    Math.trunc(targetConfig.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS),
    0,
    60_000,
  );
  const maxRetries = clamp(Math.trunc(targetConfig.maxRetries ?? DEFAULT_MAX_RETRIES), 0, 5);
  const retryBaseDelayMs = clamp(
    Math.trunc(targetConfig.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS),
    0,
    MAX_BACKOFF_MS,
  );
  const maxRequestsPerRun = clamp(
    Math.trunc(targetConfig.maxRequestsPerRun ?? DEFAULT_MAX_REQUESTS_PER_RUN),
    1,
    HARD_MAX_REQUESTS_PER_RUN,
  );

  const country = targetConfig.country ? targetConfig.country.trim().toUpperCase() : null;

  // encodeURIComponent is a no-op for the alphanumeric key Jooble issues, and
  // prevents a malformed key from injecting path/query segments if one is set.
  const endpoint = JOOBLE_API_BASE + encodeURIComponent(credentials.apiKey);

  const runState: RunState = { used: 0 };
  const pacer: Pacer = { lastRequestAt: 0 };

  const collected: DiscoveredVacancy[] = [];
  // Page results can overlap (search rankings shift between requests), so ids
  // are deduped across pages — otherwise the same job would be ingested twice
  // in one run and counted twice in seenVacancyIds.
  const seenSourceIds = new Set<string>();
  let totalCount: number | null = null;

  for (let page = 1; page <= maxPages; page += 1) {
    if (runState.used >= maxRequestsPerRun) {
      break;
    }

    const body = await postJoobleSearch(
      endpoint,
      buildRequestBody({ ...targetConfig, keywords, location }, page, resultsPerPage),
      { fetchImpl, pacer, minIntervalMs, maxRetries, retryBaseDelayMs, runState, maxRequestsPerRun },
    );

    if (!Array.isArray(body.jobs)) {
      throw new Error(
        "Jooble returned HTTP 200 but the response contained no 'jobs' array for " +
          REDACTED_JOOBLE_ENDPOINT +
          ". The response shape did not match the documented contract; this is not retried " +
          "because the same body would be returned again.",
      );
    }

    if (typeof body.totalCount === "number" && Number.isFinite(body.totalCount)) {
      totalCount = body.totalCount;
    }

    for (const job of body.jobs) {
      const normalized = normalizeJoobleJob(job, country);
      if (!normalized) {
        continue;
      }
      if (seenSourceIds.has(normalized.sourceVacancyId)) {
        continue;
      }
      seenSourceIds.add(normalized.sourceVacancyId);
      collected.push(normalized);
    }

    // Stop conditions, cheapest first: an empty page is the end of the result
    // set; a short page is the last page; and reaching totalCount means the
    // result set is fully covered.
    if (body.jobs.length === 0) {
      break;
    }
    if (body.jobs.length < resultsPerPage) {
      break;
    }
    if (totalCount !== null && seenSourceIds.size >= totalCount) {
      break;
    }
  }

  // A truncated run is not an adapter failure — it is returned as a partial
  // result set so the jobs fetched so far still ingest — but it must be
  // visible, because worker.ts's markUnseenVacanciesExpired() expires every
  // active vacancy for this vacancy_source_id that this run did not return.
  // See docs/JOOBLE_INTEGRATION.md §"Freshness interaction".
  if (totalCount !== null && seenSourceIds.size < totalCount) {
    console.warn(
      "[jooble] partial discovery: returned " +
        seenSourceIds.size +
        " of " +
        totalCount +
        " matching jobs (page budget " +
        maxPages +
        " x " +
        resultsPerPage +
        ", requests used " +
        runState.used +
        "). Unreturned vacancies of this target may be expired by the freshness sweep.",
    );
  }

  return collected;
}

const JOOBLE_SOURCE_CODE = "jooble" as const;

/**
 * Registry-facing wrapper, same shape as adzunaAdapter/usajobsAdapter: the
 * credential is read lazily from process.env at discover() time (never at
 * module load), and credential problems throw from inside discovery rather
 * than from a separate startup pre-check — the behavior worker.ts already
 * depended on for the other aggregators.
 *
 * targetKey is unused: see this module's doc comment.
 */
const joobleAdapter: DiscoveryAdapter<JoobleTargetConfig> = {
  sourceCode: JOOBLE_SOURCE_CODE,

  async discover(
    _targetKey: string,
    config: JoobleTargetConfig,
    fetchImpl: FetchImpl = fetch,
  ): Promise<DiscoveredVacancy[]> {
    // validateConfig runs first so a misconfigured target is rejected before a
    // request is spent. With a 500-request lifetime quota, that ordering is a
    // correctness requirement, not a style choice.
    this.validateConfig(config);

    return discoverJooble(config, readJoobleCredentials(), fetchImpl);
  },

  validateConfig(config: JoobleTargetConfig): void {
    if (!config || typeof config !== "object") {
      throw new Error("Jooble target config must be an object.");
    }

    const keywords = typeof config.keywords === "string" ? config.keywords.trim() : "";
    const location = typeof config.location === "string" ? config.location.trim() : "";

    if (!keywords) {
      throw new Error(
        'Jooble target config requires a non-empty "keywords" — Jooble documents it as a required request parameter.',
      );
    }

    if (!location) {
      throw new Error(
        'Jooble target config requires a non-empty "location" — Jooble documents it as a required request parameter.',
      );
    }

    if (config.radius !== undefined && !ALLOWED_RADII.includes(String(config.radius))) {
      throw new Error(
        'Jooble target config "radius" must be one of ' +
          ALLOWED_RADII.join(", ") +
          " (kilometres) — Jooble rejects any other value.",
      );
    }

    if (config.country !== undefined && config.country !== null) {
      if (typeof config.country !== "string" || config.country.trim() === "") {
        throw new Error(
          'Jooble target config "country" must be a non-empty ISO country code string (e.g. "US") or omitted.',
        );
      }
    }

    for (const [field, value] of [
      ["salary", config.salary],
      ["resultsPerPage", config.resultsPerPage],
      ["maxPages", config.maxPages],
      ["searchMode", config.searchMode],
    ] as ReadonlyArray<readonly [string, unknown]>) {
      if (value === undefined) {
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error('Jooble target config "' + field + '" must be a finite number when set.');
      }
    }
  },
};

export { joobleAdapter, JOOBLE_SOURCE_CODE };
