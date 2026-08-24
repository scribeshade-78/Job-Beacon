import type { DiscoveredVacancy, FetchImpl } from "../types.js";
import type { DiscoveryAdapter, DiscoveryAdapterConfig } from "./types.js";

/**
 * Lever Postings API (PRD §10.2 [S2]; verified directly against
 * https://github.com/lever/postings-api). Public GET, no authentication.
 *
 * targetKey = site slug (one site = one employer, same reasoning as
 * Greenhouse for why companyName/companyDomain come from target config).
 */
interface LeverTargetConfig extends DiscoveryAdapterConfig {
  companyName: string;
  companyDomain?: string;
}

interface LeverSalaryRange {
  currency?: string;
  interval?: string;
  min?: number;
  max?: number;
}

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  categories?: { location?: string };
  workplaceType?: "remote" | "hybrid" | "on-site" | "unspecified";
  salaryRange?: LeverSalaryRange;
}

const WORKPLACE_TYPE_MAP: Record<string, DiscoveredVacancy["remoteType"]> = {
  remote: "remote",
  hybrid: "hybrid",
  "on-site": "on_site",
};

const SALARY_INTERVAL_MAP: Record<string, DiscoveredVacancy["salaryInterval"]> = {
  year: "year",
  annual: "year",
  month: "month",
  monthly: "month",
  hour: "hour",
  hourly: "hour",
};

const LEVER_SOURCE_CODE = "lever" as const;

const leverAdapter: DiscoveryAdapter<LeverTargetConfig> = {
  sourceCode: LEVER_SOURCE_CODE,

  async discover(
    siteSlug: string,
    config: LeverTargetConfig,
    fetchImpl: FetchImpl = fetch,
  ): Promise<DiscoveredVacancy[]> {
    this.validateConfig(config);

    const response = await fetchImpl(
      `https://api.lever.co/v0/postings/${encodeURIComponent(siteSlug)}?mode=json`,
    );

    if (!response.ok) {
      throw new Error(`Lever discovery failed for site "${siteSlug}": HTTP ${response.status}`);
    }

    const postings = (await response.json()) as LeverPosting[];

    return postings.map((posting) => {
      const salary = posting.salaryRange;

      return {
        sourceVacancyId: posting.id,
        authoritativeUrl: posting.hostedUrl,
        rawTitle: posting.text,
        companyName: config.companyName,
        companyDomain: config.companyDomain ?? null,
        // categories.location is a single freeform string (e.g. "New York,
        // NY" or "Remote - US"), same ambiguity as Greenhouse's location
        // field — not decomposed into country/region/city without guessing.
        // The raw string survives in `raw` below.
        country: null,
        region: null,
        city: null,
        remoteType: posting.workplaceType ? (WORKPLACE_TYPE_MAP[posting.workplaceType] ?? null) : null,
        currency: salary?.currency ?? null,
        salaryMin: salary?.min ?? null,
        salaryMax: salary?.max ?? null,
        salaryInterval: salary?.interval ? (SALARY_INTERVAL_MAP[salary.interval.toLowerCase()] ?? null) : null,
        salarySource: salary ? "employer_disclosed" : null,
        publishedAt: posting.createdAt ? new Date(posting.createdAt).toISOString() : null,
        raw: posting,
      };
    });
  },

  validateConfig(config: LeverTargetConfig): void {
    if (typeof config.companyName !== "string" || config.companyName.trim() === "") {
      throw new Error(`Lever target config must include a non-empty "companyName" string.`);
    }
  },
};

export { leverAdapter, LEVER_SOURCE_CODE, type LeverTargetConfig };