/**
 * Response Intelligence Phase 3 — application matching heuristics.
 *
 * Pure: given one classified message's extracted entities and the list of
 * one candidate's own application attempts (pre-joined to their vacancy +
 * company), score each and decide whether to auto-link. No I/O — matchBatch
 * does the DB work. Candidate scoping is the caller's responsibility: this
 * function trusts that every CandidateApplication passed in belongs to the
 * same candidate as the message.
 *
 * No fuzzy-match library exists in this repo (or is warranted) — the
 * high-value signals (exact ATS job id, sender domain) are string equality
 * after normalisation; token Jaccard covers the softer company/role match.
 */

export const MATCH_AUTO_THRESHOLD = 0.85;
export const MATCH_REVIEW_THRESHOLD = 0.6;
/** Two candidates whose scores are within this of each other, both above auto, is not a confident link. */
export const MATCH_AMBIGUITY_MARGIN = 0.1;

export const MATCH_REASONS = [
  "job_id_exact",
  "sender_domain_match",
  "company_name_exact",
  "company_name_fuzzy",
  "role_title_exact",
  "role_title_fuzzy",
] as const;

export type MatchReason = (typeof MATCH_REASONS)[number];

export interface MatchInput {
  sender: string | null;
  company: string | null;
  role: string | null;
  jobId: string | null;
}

export interface CandidateApplication {
  attemptId: string;
  companyName: string | null;
  companyDomain: string | null;
  careerDomain: string | null;
  roleTitle: string | null;
  sourceVacancyId: string | null;
}

export interface ScoredApplication {
  attemptId: string;
  confidence: number;
  reasons: MatchReason[];
}

export type MatchResult =
  | { kind: "auto"; attemptId: string; confidence: number; reasons: MatchReason[] }
  | { kind: "review"; candidates: ScoredApplication[] }
  | { kind: "ambiguous"; candidates: ScoredApplication[] }
  | { kind: "none" };

const COMPANY_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "pvt",
  "private",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "plc",
  "sa",
  "ag",
]);

export function normalizeText(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "") // é -> e, ñ -> n
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenSet(value: string | null | undefined): Set<string> {
  const normalized = normalizeText(value);
  return new Set(normalized ? normalized.split(" ") : []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

function stripCompanySuffix(normalized: string): string {
  const tokens = normalized.split(" ").filter(Boolean);
  while (tokens.length > 1 && COMPANY_SUFFIXES.has(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }
  return tokens.join(" ");
}

/** Pulls the host out of a raw From header: `"Acme <jobs@careers.acme.com>"` -> `careers.acme.com`. */
export function senderDomain(sender: string | null | undefined): string | null {
  if (!sender) {
    return null;
  }
  const angle = sender.match(/<([^>]+)>/);
  const address = (angle ? angle[1]! : sender).trim();
  const at = address.lastIndexOf("@");
  if (at === -1) {
    return null;
  }
  const host = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/[>\s.]+$/, "");
  return host || null;
}

/** Last two labels — deliberately naive (`ponytail:` wrong on `foo.co.uk`; add a public-suffix list only if that matters). */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) {
    return null;
  }
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) {
    return null;
  }
  return labels.slice(-2).join(".");
}

function domainsMatch(a: string | null, b: string | null): boolean {
  const ra = registrableDomain(a);
  const rb = registrableDomain(b);
  return ra !== null && ra === rb;
}

function scoreOne(input: MatchInput, app: CandidateApplication): ScoredApplication {
  const reasons: MatchReason[] = [];
  let confidence = 0;

  const jobId = normalizeText(input.jobId);
  if (jobId && jobId === normalizeText(app.sourceVacancyId)) {
    confidence += 0.95;
    reasons.push("job_id_exact");
  }

  const from = senderDomain(input.sender);
  if (from && (domainsMatch(from, app.companyDomain) || domainsMatch(from, app.careerDomain))) {
    confidence += 0.5;
    reasons.push("sender_domain_match");
  }

  const company = stripCompanySuffix(normalizeText(input.company));
  const appCompany = stripCompanySuffix(normalizeText(app.companyName));
  if (company && appCompany && company === appCompany) {
    confidence += 0.35;
    reasons.push("company_name_exact");
  } else if (company && appCompany && jaccard(new Set(company.split(" ")), new Set(appCompany.split(" "))) >= 0.6) {
    confidence += 0.2;
    reasons.push("company_name_fuzzy");
  }

  const role = normalizeText(input.role);
  const appRole = normalizeText(app.roleTitle);
  if (role && appRole && role === appRole) {
    confidence += 0.3;
    reasons.push("role_title_exact");
  } else if (role && appRole && jaccard(tokenSet(role), tokenSet(appRole)) >= 0.5) {
    confidence += 0.15;
    reasons.push("role_title_fuzzy");
  }

  return { attemptId: app.attemptId, confidence: Math.min(confidence, 1), reasons };
}

export function scoreApplicationMatch(input: MatchInput, apps: CandidateApplication[]): MatchResult {
  const scored = apps
    .map((app) => scoreOne(input, app))
    .filter((s) => s.reasons.length > 0)
    .sort((a, b) => b.confidence - a.confidence);

  const best = scored[0];
  if (!best || best.confidence < MATCH_REVIEW_THRESHOLD) {
    return { kind: "none" };
  }

  if (best.confidence < MATCH_AUTO_THRESHOLD) {
    return { kind: "review", candidates: scored.filter((s) => s.confidence >= MATCH_REVIEW_THRESHOLD) };
  }

  const runnerUp = scored[1];
  if (runnerUp && best.confidence - runnerUp.confidence < MATCH_AMBIGUITY_MARGIN) {
    return {
      kind: "ambiguous",
      candidates: scored.filter((s) => best.confidence - s.confidence < MATCH_AMBIGUITY_MARGIN),
    };
  }

  return { kind: "auto", attemptId: best.attemptId, confidence: best.confidence, reasons: best.reasons };
}
