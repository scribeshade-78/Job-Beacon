import type { DiscoveredVacancy, FetchImpl } from "../types.js";
import type { DiscoveryAdapter, DiscoveryAdapterConfig } from "./types.js";

/**
 * Greenhouse Job Board API (PRD §10.2 [S1]; verified directly against
 * https://developers.greenhouse.io/job-board.html). Public GET, no
 * authentication — confirmed by that page: "Job Board data is publicly
 * available, so authentication is not required for any GET endpoints."
 *
 * targetKey = board_token (one board = one employer). companyName/
 * companyDomain aren't present in the jobs list response at all, so they
 * come from the target's own config (operator-supplied when the target is
 * registered), not invented or scraped.
 */
interface GreenhouseTargetConfig extends DiscoveryAdapterConfig {
  companyName: string;
  companyDomain?: string;
}

interface GreenhouseJob {
  id: number;
  title: string;
  updated_at: string;
  absolute_url: string;
  location?: { name?: string };
}

export class GreenhousePayloadError extends Error {
  constructor(detail: string) {
    super(`Greenhouse returned a payload this adapter cannot read: ${detail}`);
    this.name = "GreenhousePayloadError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Non-empty and trimmed, or null. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Maps ONE Greenhouse job, or returns null when it cannot be identified or linked.
 *
 * THE ID IS THE DANGEROUS FIELD. String(undefined) is the literal text "undefined" — a
 * non-null, entirely plausible source_vacancy_id. vacancies is unique on
 * (source_code, source_vacancy_id), so every malformed row would collapse onto a single
 * vacancy: silent corruption rather than a failed insert. The id is validated as a number
 * or a non-empty string BEFORE String() is applied.
 */
export function mapGreenhouseJob(
  job: unknown,
  config: GreenhouseTargetConfig,
): DiscoveredVacancy | null {
  const record = asRecord(job);

  const rawId = record.id;
  const sourceVacancyId =
    typeof rawId === "number" || typeof rawId === "string" ? String(rawId).trim() : "";
  const authoritativeUrl = asString(record.absolute_url);
  const rawTitle = asString(record.title);

  if (!sourceVacancyId || !authoritativeUrl || !rawTitle) {
    return null;
  }

  const typed = record as unknown as GreenhouseJob;

  return {
    sourceVacancyId,
    authoritativeUrl,
    rawTitle,
    companyName: config.companyName,
    companyDomain: config.companyDomain ?? null,
    country: null,
    region: null,
    city: null,
    remoteType: inferRemoteType(typed.location?.name),
    currency: null,
    salaryMin: null,
    salaryMax: null,
    salaryInterval: null,
    salarySource: null,
    // The jobs-list endpoint only returns updated_at, not a first-published date (that
    // field exists only on the single-job GET /jobs/{id} endpoint, which this adapter does
    // not call — one extra request per job is not justified). Used as an approximation of
    // publishedAt, not the true first-published date.
    publishedAt: asString(typed.updated_at),
    raw: typed,
  };
}

function inferRemoteType(locationName: string | undefined): DiscoveredVacancy["remoteType"] {
  // THE LEADING TOKEN, VERIFIED AGAINST THE LIVE BOARDS. Greenhouse has no structured
  // remote flag — location is one freeform string — and an exact match was too narrow for
  // how boards actually write it: on the real Stripe board only 6 of 728 locations equal
  // "Remote" while 16 BEGIN with it ("Remote from the US", "Remote - US", "Remote, US"),
  // and on Vercel NONE matched exactly while 9 begin with "Remote - ...". Every Vercel
  // remote role was therefore invisible to the work-mode filter, and because
  // practicalEligibility short-circuits on remote_type, those rows also carried location
  // blockers they should not have.
  //
  // STILL DELIBERATELY NARROW, and the leading token IS the boundary. The same boards
  // carry genuinely ambiguous values — "Dublin or Germany (Berlin or Remote)",
  // "Poland - Remote OR Romania - Remote", "US-Remote-CA, US-San Francisco, US-Seattle" —
  // which name two places or a region code and stay null. A false positive here is not a
  // cosmetic error: it silently removes a candidate's location blocker.
  if (typeof locationName !== "string") {
    return null;
  }

  const normalized = locationName.trim().toLowerCase();

  if (/^remote\b/.test(normalized)) {
    return "remote";
  }

  if (/^hybrid\b/.test(normalized)) {
    return "hybrid";
  }

  return null;
}

const GREENHOUSE_SOURCE_CODE = "greenhouse" as const;

const greenhouseAdapter: DiscoveryAdapter<GreenhouseTargetConfig> = {
  sourceCode: GREENHOUSE_SOURCE_CODE,

  async discover(
    boardToken: string,
    config: GreenhouseTargetConfig,
    fetchImpl: FetchImpl = fetch,
  ): Promise<DiscoveredVacancy[]> {
    this.validateConfig(config);

    const response = await fetchImpl(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`,
    );

    if (!response.ok) {
      throw new Error(`Greenhouse discovery failed for board "${boardToken}": HTTP ${response.status}`);
    }

    // A MALFORMED BODY IS NAMED, NOT A STACK TRACE. `body.jobs.map(...)` used to run
    // unguarded, so a null body or a renamed field threw a TypeError that the ingestion
    // worker stored verbatim as the source's health error.
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GreenhousePayloadError("the response body was not JSON");
    }

    const jobs = asRecord(payload).jobs;

    if (!Array.isArray(jobs)) {
      throw new GreenhousePayloadError("the response had no jobs array");
    }

    // UNMAPPABLE ROWS ARE SKIPPED, NOT REPAIRED — see mapGreenhouseJob.
    return jobs
      .map((job) => mapGreenhouseJob(job, config))
      .filter((vacancy): vacancy is DiscoveredVacancy => vacancy !== null);
  },

  validateConfig(config: GreenhouseTargetConfig): void {
    if (typeof config.companyName !== "string" || config.companyName.trim() === "") {
      throw new Error(`Greenhouse target config must include a non-empty "companyName" string.`);
    }
  },
};

export { greenhouseAdapter, GREENHOUSE_SOURCE_CODE, type GreenhouseTargetConfig };