import type { DiscoveredVacancy, FetchImpl } from "../types.js";
import type { DiscoveryAdapter, DiscoveryAdapterConfig } from "./types.js";

/**
 * USAJOBS Search API (PRD §10.2 [S5]).
 *
 * VERIFICATION NOTE: developer.usajobs.gov was unreachable from this
 * environment across 5 attempts (network-level, not a documentation gap —
 * Greenhouse/Lever/Adzuna's official docs all fetched successfully). The
 * header names (Authorization-Key, User-Agent = registered email, Host:
 * data.usajobs.gov) and the SearchResult.SearchResultItems[].
 * MatchedObjectDescriptor response shape are corroborated by multiple
 * independent secondary sources, not a primary-source fetch. Treat this
 * adapter's exact field mapping as provisional until verified against a
 * real API response — the fixture test pins today's understanding, not a
 * confirmed contract.
 *
 * targetKey here is a label for the saved search (not a single ID the
 * provider gives you) — USAJOBS discovery is keyword/location driven, not
 * per-employer like Greenhouse/Lever.
 */
export interface UsajobsTargetConfig extends DiscoveryAdapterConfig {
  keyword?: string;
  locationName?: string;
}

export interface UsajobsCredentials {
  apiKey: string;
  /** Must be the email address registered for this API key, not a browser UA string. */
  userAgent: string;
}

export class UsajobsPayloadError extends Error {
  constructor(detail: string) {
    super(`USAJOBS returned a payload this adapter cannot read: ${detail}`);
    this.name = "UsajobsPayloadError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Non-empty and trimmed, or null. Used for every string this mapper trusts. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * A real finite number, whether the API sends it as a string ("95000.50") or a number.
 *
 * NOT a cast and NOT a bare Number(): Number("1,000") is NaN and Number("") is 0, and both
 * would have reached a numeric column. A rate that cannot be read is no rate at all.
 */
function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

interface UsajobsPositionRemuneration {
  MinimumRange?: string;
  MaximumRange?: string;
  RateIntervalCode?: string;
}

interface UsajobsMatchedObjectDescriptor {
  PositionID: string;
  PositionTitle: string;
  PositionURI: string;
  OrganizationName?: string;
  PositionLocationDisplay?: string;
  PublicationStartDate?: string;
  PositionRemuneration?: UsajobsPositionRemuneration[];
  /**
   * The nested "User Area" carries the fields the search response does not
   * surface at the top level. Only RemoteIndicator is consumed here; the rest
   * (MajorDuties, KeyRequirements, Education, ...) is preserved verbatim in
   * vacancy_versions.raw_payload and is what the JD extractor reads.
   */
  UserArea?: {
    Details?: {
      RemoteIndicator?: boolean;
    };
  };
}

/**
 * Work-arrangement classification (Mini-Phase 3).
 *
 * USAJOBS DOES expose a real, standardised boolean for this —
 * UserArea.Details.RemoteIndicator. Verified against all 25 stored live
 * payloads (every one currently false), which also retires one caveat in this
 * file's header: the field mapping was written from secondary sources, but
 * this specific field is now confirmed against real API responses.
 *
 * Only the POSITIVE is trusted. A government dataset commonly leaves a
 * boolean false as "unspecified" rather than as an explicit denial, so
 * mapping false -> 'on_site' would assert a work arrangement the posting
 * never claimed. Absence and false are therefore both null, and this adapter
 * only ever produces 'remote' or null — never 'hybrid' or 'on_site'.
 *
 * The direction matters: practicalEligibility.ts short-circuits to "score
 * 100, no hard blockers" when remote_type is 'remote', so a false positive
 * here silently removes a candidate's location blocker.
 */
export function parseUsajobsRemoteType(remoteIndicator: unknown): "remote" | null {
  return remoteIndicator === true ? "remote" : null;
}

/**
 * Maps ONE USAJOBS item, or returns null when it cannot be identified or linked.
 *
 * SKIPPING IS THE POINT, exactly as in the Adzuna mapper: vacancies.source_vacancy_id,
 * authoritative_url and raw_title are NOT NULL, so a row missing any of them is a failed
 * insert or a garbage vacancy — not something to repair with a placeholder.
 */
export function mapUsajobsItem(entry: unknown): DiscoveredVacancy | null {
  const item = asRecord(asRecord(entry).MatchedObjectDescriptor);

  const sourceVacancyId = asString(item.PositionID);
  const authoritativeUrl = asString(item.PositionURI);
  const rawTitle = asString(item.PositionTitle);

  if (!sourceVacancyId || !authoritativeUrl || !rawTitle) {
    return null;
  }

  const descriptor = item as unknown as UsajobsMatchedObjectDescriptor;
  const remuneration = Array.isArray(descriptor.PositionRemuneration)
    ? descriptor.PositionRemuneration[0]
    : undefined;

  const min = asFiniteNumber(remuneration?.MinimumRange);
  const max = asFiniteNumber(remuneration?.MaximumRange);
  const hasSalary = min !== null || max !== null;

  return {
    sourceVacancyId,
    authoritativeUrl,
    rawTitle,
    companyName: asString(descriptor.OrganizationName) ?? "U.S. Government",
    companyDomain: null,
    country: "US",
    region: null,
    // Same freeform-string ambiguity as Greenhouse/Lever — not decomposed into
    // region/city without guessing.
    city: null,
    // Only RemoteIndicator === true maps; false and absent both stay null — see
    // parseUsajobsRemoteType.
    remoteType: parseUsajobsRemoteType(descriptor.UserArea?.Details?.RemoteIndicator),
    currency: hasSalary ? "USD" : null,
    salaryMin: min,
    salaryMax: max,
    // A RATE INTERVAL WITH NO RATE IS NOT A SALARY, so this is gated on hasSalary for the
    // same reason the amount and the source are: an interval alone asserts a salary that
    // is not there.
    salaryInterval:
      hasSalary && remuneration?.RateIntervalCode
        ? (RATE_INTERVAL_MAP[String(remuneration.RateIntervalCode).toLowerCase()] ?? null)
        : null,
    salarySource: hasSalary ? "employer_disclosed" : null,
    publishedAt: asString(descriptor.PublicationStartDate),
    raw: descriptor,
  };
}

const RATE_INTERVAL_MAP: Record<string, DiscoveredVacancy["salaryInterval"]> = {
  "per year": "year",
  annual: "year",
  "per month": "month",
  "per hour": "hour",
};

export async function discoverUsajobs(
  targetConfig: UsajobsTargetConfig,
  credentials: UsajobsCredentials,
  fetchImpl: FetchImpl = fetch,
): Promise<DiscoveredVacancy[]> {
  if (!credentials.apiKey || !credentials.userAgent) {
    throw new Error(
      "USAJOBS discovery requires an Authorization-Key and a registered User-Agent email — none configured.",
    );
  }

  const params = new URLSearchParams();
  if (targetConfig.keyword) params.set("Keyword", targetConfig.keyword);
  if (targetConfig.locationName) params.set("LocationName", targetConfig.locationName);

  const response = await fetchImpl(`https://data.usajobs.gov/api/search?${params.toString()}`, {
    headers: {
      Host: "data.usajobs.gov",
      "User-Agent": credentials.userAgent,
      "Authorization-Key": credentials.apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`USAJOBS discovery failed: HTTP ${response.status}`);
  }

  // A MALFORMED BODY IS NAMED, NOT A STACK TRACE. `body.SearchResult.SearchResultItems
  // .map(...)` used to run unguarded, so a null body, a renamed field or a non-JSON body
  // threw a TypeError that the ingestion worker stored verbatim as the source's health
  // error — naming our own code instead of the provider's payload.
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new UsajobsPayloadError("the response body was not JSON");
  }

  const items = asRecord(asRecord(payload).SearchResult).SearchResultItems;

  if (!Array.isArray(items)) {
    throw new UsajobsPayloadError("the response had no SearchResult.SearchResultItems array");
  }

  // UNMAPPABLE ROWS ARE SKIPPED, NOT REPAIRED — see mapUsajobsItem.
  return items
    .map((entry) => mapUsajobsItem(entry))
    .filter((vacancy): vacancy is DiscoveredVacancy => vacancy !== null);
}

const USAJOBS_SOURCE_CODE = "usajobs" as const;

/**
 * MP-A2.1: formalizes the pre-existing discoverUsajobs (above, unchanged)
 * as a DiscoveryAdapter for the registry. Credentials aren't part of
 * per-target config (a saved-search keyword/location has no employer to
 * own an API key) — read from process.env at call time, same lazy-env-read
 * pattern as openaiClient.ts, and same "throws inside discovery, not a
 * separate pre-check" behavior worker.ts's old switch already had.
 * targetKey is unused here — see discoverUsajobs's own doc comment on why
 * it's a saved-search label, not a value the API call consumes.
 */
const usajobsAdapter: DiscoveryAdapter<UsajobsTargetConfig> = {
  sourceCode: USAJOBS_SOURCE_CODE,

  async discover(
    _targetKey: string,
    config: UsajobsTargetConfig,
    fetchImpl: FetchImpl = fetch,
  ): Promise<DiscoveredVacancy[]> {
    this.validateConfig(config);

    return discoverUsajobs(
      config,
      {
        apiKey: process.env.USAJOBS_API_KEY ?? "",
        userAgent: process.env.USAJOBS_USER_AGENT ?? "",
      },
      fetchImpl,
    );
  },

  validateConfig(_config: UsajobsTargetConfig): void {
    // No required target-level fields — keyword/locationName are both
    // optional query params (USAJOBS discovery is keyword/location driven,
    // not per-employer, so there's nothing to fail fast on here).
    // Credential validation happens inside discoverUsajobs itself, at
    // discover() time, unchanged from before this phase.
  },
};

export { usajobsAdapter, USAJOBS_SOURCE_CODE };
