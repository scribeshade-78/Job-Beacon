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

interface GreenhouseJobsResponse {
  jobs: GreenhouseJob[];
}

function inferRemoteType(locationName: string | undefined): DiscoveredVacancy["remoteType"] {
  // Narrow, documented heuristic — Greenhouse's location is a single
  // freeform string with no structured remote/hybrid/on-site flag. Only
  // the unambiguous exact-match case is inferred; everything else is left
  // null rather than guessed from free text.
  if (locationName?.trim().toLowerCase() === "remote") {
    return "remote";
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

    const body = (await response.json()) as GreenhouseJobsResponse;

    return body.jobs.map((job) => ({
      sourceVacancyId: String(job.id),
      authoritativeUrl: job.absolute_url,
      rawTitle: job.title,
      companyName: config.companyName,
      companyDomain: config.companyDomain ?? null,
      country: null,
      region: null,
      city: null,
      remoteType: inferRemoteType(job.location?.name),
      currency: null,
      salaryMin: null,
      salaryMax: null,
      salaryInterval: null,
      salarySource: null,
      // The jobs-list endpoint only returns updated_at, not a first-published
      // date (that field exists only on the single-job GET /jobs/{id}
      // endpoint, which this adapter doesn't call — one extra request per
      // job isn't justified for R2 foundation scope). Used here as an
      // approximation of publishedAt, not the true first-published date.
      publishedAt: job.updated_at ?? null,
      raw: job,
    }));
  },

  validateConfig(config: GreenhouseTargetConfig): void {
    if (typeof config.companyName !== "string" || config.companyName.trim() === "") {
      throw new Error(`Greenhouse target config must include a non-empty "companyName" string.`);
    }
  },
};

export { greenhouseAdapter, GREENHOUSE_SOURCE_CODE, type GreenhouseTargetConfig };