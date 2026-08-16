import type { DiscoveredVacancy, FetchImpl } from "../types.js";

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
export interface AdzunaTargetConfig {
  what?: string;
  where?: string;
  resultsPerPage?: number;
}

export interface AdzunaCredentials {
  appId: string;
  appKey: string;
}

interface AdzunaResult {
  id: string;
  title: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  salary_min?: number;
  salary_max?: number;
  created?: string;
  redirect_url: string;
}

interface AdzunaSearchResponse {
  results: AdzunaResult[];
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
    throw new Error(`Adzuna discovery failed for country "${countryCode}": HTTP ${response.status}`);
  }

  const body = (await response.json()) as AdzunaSearchResponse;

  return body.results.map((result) => ({
    sourceVacancyId: result.id,
    authoritativeUrl: result.redirect_url,
    rawTitle: result.title,
    companyName: result.company?.display_name ?? "Unknown",
    companyDomain: null,
    country: countryCode.toUpperCase(),
    region: null,
    // location.display_name is a single freeform string (e.g. "London,
    // South East England"), same ambiguity as the other providers — not
    // decomposed without guessing.
    city: null,
    remoteType: null,
    currency: null,
    salaryMin: result.salary_min ?? null,
    salaryMax: result.salary_max ?? null,
    salaryInterval: result.salary_min !== undefined || result.salary_max !== undefined ? "year" : null,
    // Adzuna's overview page doesn't document whether salary_min/max is
    // employer-disclosed or Adzuna's own estimate for a given listing —
    // treated conservatively as "estimated" rather than assumed disclosed.
    salarySource: result.salary_min !== undefined || result.salary_max !== undefined ? "estimated" : null,
    publishedAt: result.created ?? null,
    raw: result,
  }));
}
