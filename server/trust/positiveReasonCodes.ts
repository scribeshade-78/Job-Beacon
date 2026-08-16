import { extractHostname, hostnameMatchesDomain } from "./hardBlocks.js";

/**
 * The subset of PRD §12.4's positive reason codes computable from real
 * signals today. Deferred: COMPANY_REGISTRY_CONFIRMED (no registry-
 * verification system exists — R5) and PRIOR_TRUSTED_EMPLOYER_HISTORY (no
 * moderation history exists yet — R3.5/R3.7), per explicit user decision.
 */
export type PositiveReasonCode =
  | "OFFICIAL_CAREER_PAGE_CONFIRMED"
  | "ATS_POSTING_CONFIRMED"
  | "CORPORATE_DOMAIN_CONFIRMED"
  | "RECENT_SOURCE_RECHECK_PASSED"
  | "SALARY_EMPLOYER_DISCLOSED";

export interface PositiveReasonCodeSignals {
  /** vacancies.authoritative_url */
  authoritativeUrl: string;
  /** companies.domain, if resolved */
  companyDomain: string | null;
  /** companies.career_domain, if resolved */
  companyCareerDomain: string | null;
  /** vacancies.source_code */
  sourceCode: string;
  /** vacancies.salary_source */
  salarySource: "employer_disclosed" | "estimated" | null;
  /** vacancies.status */
  vacancyStatus: "active" | "expired" | "removed";
  /** vacancies.last_seen_at (ISO timestamp) */
  lastSeenAt: string;
  /** ISO timestamp to treat as "now" — injectable for deterministic tests. */
  now?: string;
}

/** Greenhouse and Lever are the two source_codes that are themselves direct employer-hosted ATS boards (§12.4 example: "ATS ... posting"), distinct from usajobs/adzuna's aggregator model. */
const ATS_SOURCE_CODES = new Set(["greenhouse", "lever"]);

/** Matches trustScore.ts's freshness full-credit window — a recheck within this window is what "recent" means there too. */
const RECENT_RECHECK_HOURS = 24;

export function evaluatePositiveReasonCodes(signals: PositiveReasonCodeSignals): PositiveReasonCode[] {
  const codes: PositiveReasonCode[] = [];
  const hostname = extractHostname(signals.authoritativeUrl);

  if (hostname && signals.companyCareerDomain && hostnameMatchesDomain(hostname, signals.companyCareerDomain)) {
    codes.push("OFFICIAL_CAREER_PAGE_CONFIRMED");
  }

  if (hostname && signals.companyDomain && hostnameMatchesDomain(hostname, signals.companyDomain)) {
    codes.push("CORPORATE_DOMAIN_CONFIRMED");
  }

  if (ATS_SOURCE_CODES.has(signals.sourceCode)) {
    codes.push("ATS_POSTING_CONFIRMED");
  }

  if (signals.vacancyStatus === "active") {
    const now = new Date(signals.now ?? new Date().toISOString()).getTime();
    const lastSeen = new Date(signals.lastSeenAt).getTime();
    const hoursSinceSeen = (now - lastSeen) / (1000 * 60 * 60);

    if (hoursSinceSeen <= RECENT_RECHECK_HOURS) {
      codes.push("RECENT_SOURCE_RECHECK_PASSED");
    }
  }

  if (signals.salarySource === "employer_disclosed") {
    codes.push("SALARY_EMPLOYER_DISCLOSED");
  }

  return codes;
}
