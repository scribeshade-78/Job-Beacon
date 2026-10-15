import type { DiscoveredVacancy, FetchImpl } from "../types.js";
import type { DiscoveryAdapter, DiscoveryAdapterConfig } from "./types.js";

/**
 * Adzuna Jobs Search API (PRD §10.2 [S3], §28's "one licensed aggregator" —
 * verified directly against https://developer.adzuna.com/overview and
 * https://developer.adzuna.com/docs/search).
 *
 * targetKey = ISO country code Adzuna expects in the URL path (e.g. "us",
 * "gb"). Unlike Greenhouse/Lever, Adzuna is genuinely a multi-employer
 * aggregator, so companyName comes from each result's own
 * company.display_name — not from target config.
 */
export interface AdzunaTargetConfig extends DiscoveryAdapterConfig {
  what?: string;
  where?: string;
  resultsPerPage?: number;
}

export interface AdzunaCredentials {
  appId: string;
  appKey: string;
}

export class AdzunaPayloadError extends Error {
  constructor(detail: string) {
    super(`Adzuna returned a payload this adapter cannot read: ${detail}`);
    this.name = "AdzunaPayloadError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Non-empty, trimmed, or null. Used for every string this mapper trusts. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Only a real finite number is a salary; an explicit null is not one. */
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Did the EMPLOYER state this salary, or did Adzuna predict it?
 *
 * Only an explicit "not predicted" counts. An absent, null or unrecognised flag returns
 * false, because claiming an employer published a salary they did not is worse than
 * under-claiming it. The live API sends the string "0"; the numeric form is accepted too
 * so a shape change cannot silently start under-ranking disclosed salaries again.
 */
function isEmployerDisclosed(value: unknown): boolean {
  return value === "0" || value === 0;
}

/**
 * Adzuna's own explanation, when it sends one, read best-effort.
 *
 * "HTTP 401" alone sends an operator to the Adzuna dashboard with nothing to search
 * for, while the body names the actual fault ("invalid app_key"). A non-JSON error body
 * is not itself worth a different failure, so this returns an empty suffix rather than
 * throwing over the original problem.
 */
async function describeAdzunaError(response: Response): Promise<string> {
  try {
    const body = asRecord(await response.json());
    const detail = asString(body.exception) ?? asString(body.error) ?? asString(body.message);
    return detail ? `: ${detail}` : "";
  } catch {
    return "";
  }
}

/**
 * Maps ONE Adzuna result, or returns null when the row cannot be identified or linked.
 *
 * SKIPPING IS THE POINT. vacancies.source_vacancy_id, authoritative_url and raw_title
 * are NOT NULL, so a row missing any of them is a failed insert or a garbage vacancy —
 * not something to repair with "Unknown". The caller filters the nulls out.
 */
export function mapAdzunaResult(result: AdzunaResult, countryCode: string): DiscoveredVacancy | null {
  const rawId = result.id;
  const sourceVacancyId =
    typeof rawId === "string" || typeof rawId === "number" ? String(rawId).trim() : "";
  const authoritativeUrl = asString(result.redirect_url);
  const rawTitle = asString(result.title);

  if (!sourceVacancyId || !authoritativeUrl || !rawTitle) {
    return null;
  }

  // SALARY IS "KNOWN" ONLY WHEN A NUMBER IS PRESENT. The old check was
  // `!== undefined`, which is true for an explicit null — marking a row as an annual
  // estimate while every salary field stayed null.
  const salaryMin = asNumber(result.salary_min);
  const salaryMax = asNumber(result.salary_max);
  const hasSalary = salaryMin !== null || salaryMax !== null;

  const area = Array.isArray(result.location?.area) ? result.location.area : [];

  return {
    sourceVacancyId,
    authoritativeUrl,
    rawTitle,
    companyName: asString(result.company?.display_name) ?? "Unknown",
    companyDomain: null,
    country: countryCode.toUpperCase(),
    // REGION FROM area[1], THE SAME STRUCTURED ARRAY THE CITY ALREADY TRUSTS.
    // area is ["India","Tamil Nadu","Bangalore"] on real payloads; leaving region null
    // while the state sat one slot away was a mapping gap, not a source limitation.
    // display_name is still never decomposed — that would be guessing.
    region: asString(area[1]),
    city: asString(area[2]),
    // DELIBERATELY NULL, NOT AN OVERSIGHT. Adzuna exposes no structured remote field:
    // the live payload's complete key set is __CLASS__, adref, category, company,
    // contract_time, contract_type, created, description, id, latitude, location,
    // longitude, redirect_url, salary_is_predicted, salary_max, salary_min, title. A
    // what=Remote search is a KEYWORD match rather than a filter — a live GB run returned
    // "Nurse Disability Assessor Hybrid Work from Home" — so only free text in
    // title/description carries the signal. Deriving a filter from that would be guessing,
    // and Remotive carries the remote filter meanwhile.
    remoteType: null,
    currency: null,
    salaryMin,
    salaryMax,
    salaryInterval: hasSalary ? "year" : null,
    // THE DISCLOSURE FLAG WAS BEING IGNORED. salary_is_predicted is Adzuna's own answer to
    // "did the employer state this figure": "0" disclosed, "1" predicted. Hardcoding
    // "estimated" was wrong twice over — the UI printed "(estimated)" for a salary the
    // employer published, and priorityScore scores employer_disclosed at 90 (range) / 70
    // (single figure) against 50 for estimated, so those vacancies ranked lower for the
    // wrong reason.
    //
    // No figure means no source at all, whatever the flag says: "not predicted" is not a
    // salary.
    salarySource: hasSalary
      ? isEmployerDisclosed(result.salary_is_predicted)
        ? "employer_disclosed"
        : "estimated"
      : null,
    publishedAt: asString(result.created),
    raw: result,
  };
}

interface AdzunaResult {
  id: string;
  title: string;
  company?: { display_name?: string };
  // CAPTURED FROM REAL 200s, NOT FROM DOCUMENTATION. `area` is absent from the
  // first version of this interface, which is why city was null on every Adzuna row
  // and why Phase 2 had no cities to offer. Live shape: ["US","Kansas","Sedgwick
  // County"], ["India","Tamil Nadu","Bangalore"], sometimes just ["India"].
  location?: { display_name?: string; area?: string[] };
  salary_min?: number;
  salary_max?: number;
  /**
   * Adzuna's disclosure flag, sent as the STRING "0" (the employer stated the figure) or
   * "1" (Adzuna predicted it). Typed unknown because it is read from an untyped payload;
   * anything that is not a clear "not predicted" is treated as estimated.
   */
  salary_is_predicted?: unknown;
  created?: string;
  redirect_url: string;
}

export async function discoverAdzuna(
  countryCode: string,
  targetConfig: AdzunaTargetConfig,
  credentials: AdzunaCredentials,
  fetchImpl: FetchImpl = fetch,
): Promise<DiscoveredVacancy[]> {
  if (!credentials.appId || !credentials.appKey) {
    throw new Error("Adzuna discovery requires app_id and app_key — none configured.");
  }

  const params = new URLSearchParams({ app_id: credentials.appId, app_key: credentials.appKey });
  if (targetConfig.what) params.set("what", targetConfig.what);
  if (targetConfig.where) params.set("where", targetConfig.where);
  if (targetConfig.resultsPerPage) params.set("results_per_page", String(targetConfig.resultsPerPage));

  const response = await fetchImpl(
    `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(countryCode)}/search/1?${params.toString()}`,
    { headers: { Accept: "application/json" } },
  );

  if (!response.ok) {
    throw new Error(
      `Adzuna discovery failed for country "${countryCode}": HTTP ${response.status}${await describeAdzunaError(response)}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AdzunaPayloadError("the response body was not JSON");
  }

  const results = asRecord(payload).results;

  // A MALFORMED BODY IS NAMED, NOT A STACK TRACE. `body.results.map` on a missing key
  // used to throw "Cannot read properties of undefined (reading 'map')", which the
  // worker stored verbatim as the source's health error — naming our own code instead
  // of the provider's payload.
  if (!Array.isArray(results)) {
    throw new AdzunaPayloadError("the response had no results array");
  }

  // UNMAPPABLE ROWS ARE SKIPPED, NOT REPAIRED — see mapAdzunaResult.
  return (results as AdzunaResult[])
    .map((result) => mapAdzunaResult(result, countryCode))
    .filter((vacancy): vacancy is DiscoveredVacancy => vacancy !== null);
}

const ADZUNA_SOURCE_CODE = "adzuna" as const;

/**
 * MP-A2.1: formalizes the pre-existing discoverAdzuna (above, unchanged) as
 * a DiscoveryAdapter for the registry. Credentials aren't part of
 * per-target config (Adzuna is a multi-employer aggregator — a country
 * code has no employer to own an API key) — read from process.env at call
 * time, same lazy-env-read pattern as openaiClient.ts, and same "throws
 * inside discovery, not a separate pre-check" behavior worker.ts's old
 * switch already had. targetKey = countryCode, matching discoverAdzuna's
 * own first parameter.
 */
const adzunaAdapter: DiscoveryAdapter<AdzunaTargetConfig> = {
  sourceCode: ADZUNA_SOURCE_CODE,

  async discover(
    targetKey: string,
    config: AdzunaTargetConfig,
    fetchImpl: FetchImpl = fetch,
  ): Promise<DiscoveredVacancy[]> {
    this.validateConfig(config);

    return discoverAdzuna(
      targetKey,
      config,
      {
        appId: process.env.ADZUNA_APP_ID ?? "",
        appKey: process.env.ADZUNA_APP_KEY ?? "",
      },
      fetchImpl,
    );
  },

  validateConfig(_config: AdzunaTargetConfig): void {
    // No required target-level fields — what/where/resultsPerPage are all
    // optional query params. Credential validation happens inside
    // discoverAdzuna itself, at discover() time, unchanged from before
    // this phase.
  },
};

export { adzunaAdapter, ADZUNA_SOURCE_CODE };
