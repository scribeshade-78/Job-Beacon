/**
 * What every discovery adapter normalizes a raw provider listing into.
 * Deliberately excludes canonical_role_id/seniority/function/skill_requirements
 * (PRD §11.2 Role group) — resolving those needs a role taxonomy, which
 * doesn't exist anywhere in this repository (the same gap R1 already
 * documented as blocked for manual role search).
 */
export interface DiscoveredVacancy {
  sourceVacancyId: string;
  authoritativeUrl: string;
  rawTitle: string;
  companyName: string;
  companyDomain: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  remoteType: "remote" | "hybrid" | "on_site" | null;
  currency: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryInterval: "year" | "month" | "hour" | null;
  salarySource: "employer_disclosed" | "estimated" | null;
  publishedAt: string | null;
  /** Raw provider payload for this one listing, stored verbatim in vacancy_versions. */
  raw: unknown;
}

export type FetchImpl = typeof fetch;
