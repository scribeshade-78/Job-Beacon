import { extractHostname, hostnameMatchesDomain, matchesHardBlockContentPatterns } from "./hardBlocks.js";

/**
 * The 8-dimension weighted trust score (PRD §12.2). Weights verified
 * directly against the source PDF with two independent extraction passes
 * (`pdftotext -layout` and plain reading-order) after the first `-layout`
 * pass silently dropped the 8th row ("Scam and prohibited-content
 * signals") — both passes agree on this order and these weights, and they
 * sum to exactly 100:
 *
 *   Employer identity                    20
 *   Authoritative source                 20
 *   URL and application integrity        15
 *   Freshness and availability           10
 *   Content consistency                  10
 *   Candidate and moderator history      10
 *   Salary plausibility                   5
 *   Scam and prohibited-content signals  10
 *
 * "The score is explainable but not absolute. Hard-block rules override
 * the numeric result" (PRD §12.2) — this module never sets BLOCKED itself;
 * that's applyHardBlocks.ts (R3.2), evaluated separately and taking
 * precedence regardless of what this score computes.
 *
 * Each dimension function returns a fraction in [0, 1]; the final score is
 * the weighted sum, 0-100. Where no real signal producer exists yet (see
 * per-field comments below), the dimension scores a neutral 0.5 rather
 * than guessing full or zero credit — consistent with hardBlocks.ts's rule
 * that a missing signal must never manufacture a false positive (or, here,
 * a false full-trust result either).
 */
export interface TrustScoreSignals {
  // --- Employer identity (weight 20) ---
  /** vacancies.authoritative_url */
  authoritativeUrl: string;
  /** companies.domain, if resolved */
  companyDomain: string | null;
  /** companies.career_domain, if resolved */
  companyCareerDomain: string | null;
  /**
   * Legal-entity/registry verification (PRD §12.2 example: "registry
   * status"). Not yet wired — no registry-verification system exists in
   * this repo; that's R5 scope (company_legal_entities/company_registry_records,
   * per the R2 companies.sql comment). The minimal identity-resolution
   * signal actually available today is the domain match below.
   */
  registryVerified?: boolean;
  /**
   * source_policies.employer_identity_authoritative — true when the source
   * is itself the authoritative system of record for who the employer is
   * (e.g. a government hiring portal that publishes agency vacancies
   * directly), so no domain match or legal-entity lookup is needed to
   * establish identity.
   *
   * Exists because the domain match below is structurally unreachable for
   * every aggregator source: Jooble/USAJOBS/Adzuna adapters set
   * companyDomain to null, and the URL they store belongs to the aggregator
   * (jooble.org/jdp/...), so employerIdentity could never score above 0 and
   * the tier's total was capped at 65 against a VERIFIED threshold of 80 —
   * every aggregator vacancy stayed invisible to candidates forever. See
   * 20260917120000_source_authority_employer_identity.sql.
   *
   * Must NOT be set for an aggregator that merely mirrors third-party
   * postings — that would defeat the dimension rather than satisfy it.
   */
  sourceAuthoritativeForEmployer?: boolean;

  // --- Authoritative source (weight 20) ---
  /** source_policies.discovery_allowed for this vacancy's source */
  sourceDiscoveryAllowed: boolean;
  /** source_policies.kill_switch for this vacancy's source */
  sourceKillSwitch: boolean;

  // --- URL and application integrity (weight 15) ---
  /** Whether the final redirect target uses TLS. Not yet wired — no redirect-chain check exists yet (same gap as hardBlocks.ts). */
  redirectIsTls?: boolean;

  // --- Freshness and availability (weight 10) ---
  /** vacancies.status */
  vacancyStatus: "active" | "expired" | "removed";
  /** vacancies.last_seen_at (ISO timestamp) */
  lastSeenAt: string;
  /** ISO timestamp to treat as "now" — injectable for deterministic tests; defaults to the real current time. */
  now?: string;

  // --- Content consistency (weight 10) ---
  /**
   * Whether role/company/location agree across this vacancy's source
   * records. Not yet wired — no cross-source field-consistency comparison
   * exists in the ingestion pipeline today (R2's dedup logic matches
   * records, it doesn't score their field agreement).
   */
  crossSourceConsistent?: boolean;

  // --- Candidate and moderator history (weight 10) ---
  /** Whether prior reports/moderator decisions for this vacancy or company are clean. Not yet wired — no moderation_cases/reports table exists yet (R3.5/R3.7). */
  moderatorHistoryClean?: boolean;

  // --- Salary plausibility (weight 5) ---
  /** vacancies.salary_min */
  salaryMin: number | null;
  /** vacancies.salary_max */
  salaryMax: number | null;

  // --- Scam and prohibited-content signals (weight 10) ---
  /** Normalized job-description text. Not yet wired — same gap as hardBlocks.ts. */
  descriptionText?: string;
}

export const DIMENSION_WEIGHTS = {
  employerIdentity: 20,
  authoritativeSource: 20,
  urlIntegrity: 15,
  freshness: 10,
  contentConsistency: 10,
  moderatorHistory: 10,
  salaryPlausibility: 5,
  scamSignals: 10,
} as const;

export type TrustDimensionName = keyof typeof DIMENSION_WEIGHTS;

export interface TrustScoreDimension {
  name: TrustDimensionName;
  weight: number;
  fraction: number;
  points: number;
}

export interface TrustScoreResult {
  /** 0-100, sum of every dimension's weighted points, rounded. */
  total: number;
  dimensions: TrustScoreDimension[];
}

function knownDomainsOf(signals: TrustScoreSignals): string[] {
  return [signals.companyDomain, signals.companyCareerDomain].filter((domain): domain is string => Boolean(domain));
}

/** Minimal identity-resolution signal agreed for R3: domain match only — no legal-entity/registry system exists yet (R5). */
function scoreEmployerIdentity(signals: TrustScoreSignals): number {
  // Both of these establish identity without a domain match, so they are
  // checked before it. sourceAuthoritativeForEmployer is the per-source
  // property (see its own doc comment); registryVerified is the
  // legal-entity lookup path R5 was to provide and still does not.
  if (signals.registryVerified) return 1;
  if (signals.sourceAuthoritativeForEmployer) return 1;

  const hostname = extractHostname(signals.authoritativeUrl);
  const knownDomains = knownDomainsOf(signals);

  if (!hostname || knownDomains.length === 0) return 0;

  return knownDomains.some((domain) => hostnameMatchesDomain(hostname, domain)) ? 1 : 0;
}

function scoreAuthoritativeSource(signals: TrustScoreSignals): number {
  return signals.sourceDiscoveryAllowed && !signals.sourceKillSwitch ? 1 : 0;
}

function scoreUrlIntegrity(signals: TrustScoreSignals): number {
  let score = 1;

  const hostname = extractHostname(signals.authoritativeUrl);
  const knownDomains = knownDomainsOf(signals);

  if (hostname && knownDomains.length > 0 && !knownDomains.some((domain) => hostnameMatchesDomain(hostname, domain))) {
    score -= 0.5;
  }

  if (signals.redirectIsTls === false) {
    score -= 0.5;
  }

  return Math.max(0, score);
}

const FRESHNESS_FULL_CREDIT_HOURS = 24;
const FRESHNESS_ZERO_CREDIT_HOURS = 168; // 7 days

function scoreFreshness(signals: TrustScoreSignals): number {
  if (signals.vacancyStatus !== "active") return 0;

  const now = new Date(signals.now ?? new Date().toISOString()).getTime();
  const lastSeen = new Date(signals.lastSeenAt).getTime();
  const hoursSinceSeen = (now - lastSeen) / (1000 * 60 * 60);

  if (hoursSinceSeen <= FRESHNESS_FULL_CREDIT_HOURS) return 1;
  if (hoursSinceSeen >= FRESHNESS_ZERO_CREDIT_HOURS) return 0;

  return 1 - (hoursSinceSeen - FRESHNESS_FULL_CREDIT_HOURS) / (FRESHNESS_ZERO_CREDIT_HOURS - FRESHNESS_FULL_CREDIT_HOURS);
}

function scoreContentConsistency(signals: TrustScoreSignals): number {
  if (signals.crossSourceConsistent === undefined) return 0.5;
  return signals.crossSourceConsistent ? 1 : 0;
}

function scoreModeratorHistory(signals: TrustScoreSignals): number {
  if (signals.moderatorHistoryClean === undefined) return 0.5;
  return signals.moderatorHistoryClean ? 1 : 0;
}

/**
 * Real internal-consistency check only (min <= max, positive values) — not
 * a market-plausibility check against role/location/seniority benchmarks,
 * which needs the salary-benchmark data R5 ("Salary Intelligence") builds,
 * not yet present here.
 */
function scoreSalaryPlausibility(signals: TrustScoreSignals): number {
  const { salaryMin, salaryMax } = signals;

  if (salaryMin == null && salaryMax == null) return 0.5;
  if (salaryMin != null && salaryMin <= 0) return 0;
  if (salaryMax != null && salaryMax <= 0) return 0;
  if (salaryMin != null && salaryMax != null && salaryMin > salaryMax) return 0;

  return 1;
}

const SOFT_SCAM_PATTERNS = [
  /wire transfer/i,
  /cryptocurrency/i,
  /western union/i,
  /act now/i,
  /limited spots/i,
  /no interview necessary/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Soft/partial version of the hard-block content rules (PRD §12.2 example:
 * "Payment, MLM, identity collection, cheque/crypto" — the same category
 * as three of hardBlocks.ts's reason codes). A hard-block-tier match here
 * scores 0, but in practice applyHardBlocks.ts will already have set
 * BLOCKED before this score matters ("hard-block rules override the
 * numeric result"). This dimension's real value is catching weaker,
 * scam-adjacent language that doesn't cross the hard-block threshold.
 */
function scoreScamSignals(signals: TrustScoreSignals): number {
  if (!signals.descriptionText) return 0.5;
  if (matchesHardBlockContentPatterns(signals.descriptionText)) return 0;
  if (matchesAny(signals.descriptionText, SOFT_SCAM_PATTERNS)) return 0.4;

  return 1;
}

export function computeTrustScore(signals: TrustScoreSignals): TrustScoreResult {
  const fractionByDimension: Record<TrustDimensionName, number> = {
    employerIdentity: scoreEmployerIdentity(signals),
    authoritativeSource: scoreAuthoritativeSource(signals),
    urlIntegrity: scoreUrlIntegrity(signals),
    freshness: scoreFreshness(signals),
    contentConsistency: scoreContentConsistency(signals),
    moderatorHistory: scoreModeratorHistory(signals),
    salaryPlausibility: scoreSalaryPlausibility(signals),
    scamSignals: scoreScamSignals(signals),
  };

  const dimensions: TrustScoreDimension[] = (Object.keys(DIMENSION_WEIGHTS) as TrustDimensionName[]).map((name) => {
    const weight = DIMENSION_WEIGHTS[name];
    const fraction = fractionByDimension[name];
    return { name, weight, fraction, points: weight * fraction };
  });

  const total = Math.round(dimensions.reduce((sum, dimension) => sum + dimension.points, 0));

  return { total, dimensions };
}
