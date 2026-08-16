/**
 * Pure hard-block rule evaluation (PRD §12.3: the 10 named hard-block
 * reason codes). Deterministic and testable, no ML — matches the project's
 * rule that hard blocks must be reason-coded and explainable.
 *
 * Signal availability today: checked directly against
 * server/ingestion/types.ts (DiscoveredVacancy) and all four adapters —
 * none normalize job-description text, redirect-chain, or TLS data. No
 * moderation_cases/moderation_decisions table exists yet (R3.5 scope).
 * Those signals are typed optional below; until a later mini-phase wires a
 * real producer for them, the rules that depend on them simply won't fire
 * (never a false positive from a missing signal) — the evaluation logic
 * itself is complete and unit-tested now against constructed inputs.
 */
export interface HardBlockSignals {
  // --- Wired to real ingestion/schema data today ---
  /** vacancies.authoritative_url */
  authoritativeUrl: string;
  /** companies.domain, if resolved */
  companyDomain: string | null;
  /** companies.career_domain, if resolved */
  companyCareerDomain: string | null;
  /** source_policies.discovery_allowed for this vacancy's source */
  sourceDiscoveryAllowed: boolean;
  /** source_policies.kill_switch for this vacancy's source */
  sourceKillSwitch: boolean;
  /** vacancies.status */
  vacancyStatus: "active" | "expired" | "removed";

  // --- Not yet produced by any real pipeline stage (see module doc) ---
  /** Normalized job-description text. No adapter/schema field produces this yet. */
  descriptionText?: string;
  /** Final URL after following redirects, once a redirect check exists. */
  finalRedirectUrl?: string;
  /** Whether the final redirect target uses TLS. */
  redirectIsTls?: boolean;
  /** Whether a moderator has already recorded a block for this vacancy (moderation_cases — R3.5, doesn't exist yet). */
  priorModeratorBlock?: boolean;
}

export type HardBlockReasonCode =
  | "PAYMENT_OR_FEE_REQUEST"
  | "PHISHING_OR_MALWARE_REDIRECT"
  | "COMPANY_IMPERSONATION"
  | "UNAUTHORIZED_SOURCE_ACCESS"
  | "MLM_OR_PYRAMID_RISK"
  | "PREMATURE_BANK_OR_GOVERNMENT_ID_REQUEST"
  | "VACANCY_REMOVED"
  | "PROHIBITED_OR_ILLEGAL_REQUIREMENT"
  | "DOMAIN_MISMATCH_WITH_NO_EXPLANATION"
  | "CONFIRMED_MODERATOR_BLOCK";

const PAYMENT_PATTERNS = [
  /registration fee/i,
  /processing fee/i,
  /pay .{0,15}(to (start|begin|apply))/i,
  /security deposit/i,
  /training fee/i,
  /purchase .{0,15}starter kit/i,
];

const MLM_PATTERNS = [
  /pyramid/i,
  /multi-?level marketing/i,
  /\bmlm\b/i,
  /recruit (\d+|other) (people|members|distributors)/i,
  /\bbuy-?in\b/i,
  /starter kit/i,
];

const PREMATURE_ID_PATTERNS = [
  /bank account number/i,
  /routing number/i,
  /social security number/i,
  /\bssn\b/i,
  /\baadhaar\b/i,
  /\bpan card\b/i,
  /passport (number|copy)/i,
];

const PROHIBITED_PATTERNS = [
  /no experience.{0,20}\$\d/i,
  /guaranteed income/i,
  /work from home.{0,10}\$\d{3,}\s*\/\s*day/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, "");
  return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
}

function levenshtein(a: string, b: string): number {
  const distances: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i++) distances[i][0] = i;
  for (let j = 0; j <= b.length; j++) distances[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      distances[i][j] =
        a[i - 1] === b[j - 1]
          ? distances[i - 1][j - 1]
          : 1 + Math.min(distances[i - 1][j - 1], distances[i - 1][j], distances[i][j - 1]);
    }
  }

  return distances[a.length][b.length];
}

/**
 * Typosquat heuristic distinguishing COMPANY_IMPERSONATION from a plain
 * DOMAIN_MISMATCH_WITH_NO_EXPLANATION: the hostname's label is a
 * near-miss of a known domain's label (close edit distance, or the known
 * label embedded with extra characters — e.g. "acme-careers.net" vs the
 * real "acme.com") rather than something wholly unrelated.
 */
function isSuspiciouslySimilar(hostname: string, domain: string): boolean {
  const hostnameLabel = hostname.split(".")[0];
  const domainLabel = domain.toLowerCase().replace(/^www\./, "").split(".")[0];

  if (hostnameLabel === domainLabel) return false;
  if (domainLabel.length >= 3 && hostnameLabel.includes(domainLabel)) return true;

  return domainLabel.length >= 4 && levenshtein(hostnameLabel, domainLabel) <= 2;
}

export function evaluateHardBlocks(signals: HardBlockSignals): HardBlockReasonCode[] {
  const triggered: HardBlockReasonCode[] = [];

  if (signals.priorModeratorBlock) {
    triggered.push("CONFIRMED_MODERATOR_BLOCK");
  }

  if (signals.vacancyStatus === "removed") {
    triggered.push("VACANCY_REMOVED");
  }

  if (!signals.sourceDiscoveryAllowed || signals.sourceKillSwitch) {
    triggered.push("UNAUTHORIZED_SOURCE_ACCESS");
  }

  const hostname = extractHostname(signals.authoritativeUrl);
  const knownDomains = [signals.companyDomain, signals.companyCareerDomain].filter(
    (domain): domain is string => Boolean(domain),
  );

  if (hostname && knownDomains.length > 0) {
    const matchesKnownDomain = knownDomains.some((domain) => hostnameMatchesDomain(hostname, domain));

    if (!matchesKnownDomain) {
      const isImpersonation = knownDomains.some((domain) => isSuspiciouslySimilar(hostname, domain));
      triggered.push(isImpersonation ? "COMPANY_IMPERSONATION" : "DOMAIN_MISMATCH_WITH_NO_EXPLANATION");
    }
  }

  if (signals.redirectIsTls === false) {
    triggered.push("PHISHING_OR_MALWARE_REDIRECT");
  } else if (signals.finalRedirectUrl && !extractHostname(signals.finalRedirectUrl)) {
    triggered.push("PHISHING_OR_MALWARE_REDIRECT");
  }

  if (signals.descriptionText) {
    if (matchesAny(signals.descriptionText, PAYMENT_PATTERNS)) {
      triggered.push("PAYMENT_OR_FEE_REQUEST");
    }
    if (matchesAny(signals.descriptionText, MLM_PATTERNS)) {
      triggered.push("MLM_OR_PYRAMID_RISK");
    }
    if (matchesAny(signals.descriptionText, PREMATURE_ID_PATTERNS)) {
      triggered.push("PREMATURE_BANK_OR_GOVERNMENT_ID_REQUEST");
    }
    if (matchesAny(signals.descriptionText, PROHIBITED_PATTERNS)) {
      triggered.push("PROHIBITED_OR_ILLEGAL_REQUIREMENT");
    }
  }

  return triggered;
}
