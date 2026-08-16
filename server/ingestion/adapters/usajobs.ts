import type { DiscoveredVacancy, FetchImpl } from "../types.js";

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
export interface UsajobsTargetConfig {
  keyword?: string;
  locationName?: string;
}

export interface UsajobsCredentials {
  apiKey: string;
  /** Must be the email address registered for this API key, not a browser UA string. */
  userAgent: string;
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
}

interface UsajobsSearchResponse {
  SearchResult: {
    SearchResultItems: Array<{ MatchedObjectDescriptor: UsajobsMatchedObjectDescriptor }>;
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

  const body = (await response.json()) as UsajobsSearchResponse;

  return body.SearchResult.SearchResultItems.map(({ MatchedObjectDescriptor: item }) => {
    const remuneration = item.PositionRemuneration?.[0];
    const min = remuneration?.MinimumRange ? Number(remuneration.MinimumRange) : null;
    const max = remuneration?.MaximumRange ? Number(remuneration.MaximumRange) : null;

    return {
      sourceVacancyId: item.PositionID,
      authoritativeUrl: item.PositionURI,
      rawTitle: item.PositionTitle,
      companyName: item.OrganizationName ?? "U.S. Government",
      companyDomain: null,
      country: "US",
      region: null,
      // Same freeform-string ambiguity as Greenhouse/Lever — not
      // decomposed into region/city without guessing.
      city: null,
      remoteType: null,
      currency: min !== null || max !== null ? "USD" : null,
      salaryMin: min,
      salaryMax: max,
      salaryInterval: remuneration?.RateIntervalCode
        ? (RATE_INTERVAL_MAP[remuneration.RateIntervalCode.toLowerCase()] ?? null)
        : null,
      salarySource: min !== null || max !== null ? "employer_disclosed" : null,
      publishedAt: item.PublicationStartDate ?? null,
      raw: item,
    };
  });
}
