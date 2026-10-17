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
 *
 * TWO THINGS THIS MODULE USED TO GET WRONG, both found by running it over realistic mail
 * (scripts/mailbox-match-audit.ts) rather than by reading it:
 *
 *   1. registrableDomain was "the last two labels", so EVERY .co.uk host collapsed to "co.uk"
 *      and an unrelated UK agency matched the employer's domain outright. A false
 *      sender_domain_match is worth 0.5, which was enough to carry an unrelated email to
 *      confidence 1.00 and AUTO-LINK it to the wrong application. It now uses a real public
 *      suffix list.
 *
 *   2. A rejection relayed through an ATS comes from the VENDOR, not the employer, so its
 *      sender never matches and an exact company name is only 0.35 - below the 0.60 review
 *      floor. The commonest mail in the system was silently dropped. Relay senders now make an
 *      exact company name worth much more, so those emails reach a human instead of vanishing.
 */

import { getDomain } from "tldts";

export const MATCH_AUTO_THRESHOLD = 0.85;
export const MATCH_REVIEW_THRESHOLD = 0.6;
/** Two candidates whose scores are within this of each other, both above auto, is not a confident link. */
export const MATCH_AMBIGUITY_MARGIN = 0.1;

/**
 * How many INDEPENDENT reasons an auto-link needs, after the sender domain is set aside.
 *
 * CONFIDENCE IS A SUM, AND A SUM OF WEAK SIGNALS IS NOT EVIDENCE. sender_domain_match is worth
 * 0.5 and company_name_exact 0.35, which add to exactly 0.85 - the auto threshold - so a spoofed
 * From header plus a company name anyone could guess used to bind an application with no human in
 * the loop. That is the arithmetic of the historical .co.uk false positive, and it survived the
 * public-suffix fix because the fix corrected WHICH domain matched, not what a domain is worth.
 *
 * A SENDER DOMAIN IS NOT INDEPENDENT EVIDENCE OF PROVENANCE. It is a header the sender writes.
 * Requiring two reasons that are not it means an auto-link needs something the attacker must know
 * ABOUT THE APPLICATION - an id, a role, a company - beyond the identity they can assert.
 */
export const MIN_INDEPENDENT_REASONS_FOR_AUTO = 2;

export const MATCH_REASONS = [
  "job_id_exact",
  "sender_domain_match",
  "company_name_exact",
  "company_name_fuzzy",
  "role_title_exact",
  "role_title_fuzzy",
  /**
   * An exact company name in mail sent from a KNOWN ATS VENDOR rather than from the employer.
   * A distinct reason because it is a distinct piece of evidence: the name is exact, and the
   * sender corroborates that this is an application-system notification rather than a stranger
   * who happens to know the company's name.
   */
  "relay_company_exact",
  /**
   * A reply token resolved to an application attempt.
   *
   * The only reason in this list that is not a guess about strings: it is a keyed MAC of the
   * attempt id, minted into the address the employer replied to, and it is unguessable without
   * the signing secret. That is why it is also the only reason that can decide a link without
   * scoring at all.
   */
  "reply_token_verified",
] as const;

export type MatchReason = (typeof MATCH_REASONS)[number];

export interface MatchInput {
  sender: string | null;
  company: string | null;
  role: string | null;
  jobId: string | null;
  /**
   * The receiving provider's raw Authentication-Results header.
   *
   * OPTIONAL, AND ABSENT MEANS UNKNOWN. Every existing caller and test omits it, and every message
   * polled before the column existed leaves it null - so treating an absent value as a pass would
   * silently downgrade every one of them to "trusted". It is the only input here that speaks to
   * WHO SENT THIS rather than to string similarity.
   */
  authResults?: string | null;
  /**
   * The attempt a VERIFIED reply token resolved to.
   *
   * OPTIONAL, AND ABSENT MEANS NO TOKEN — not "unverified". The scorer still re-checks it against
   * the applications it was given, so a caller holding a stale id can never link an attempt this
   * function was not shown.
   */
  verifiedAttemptId?: string | null;
}

export type AuthVerdict = "pass" | "fail" | "unknown";

/**
 * Read the receiving provider's verdict on the sending domain.
 *
 * FAIL IS CHECKED BEFORE PASS, AND ANY FAILURE WINS. A header routinely carries several verdicts -
 * "spf=pass; dkim=fail" - and the message is only as trustworthy as its weakest one. Checking
 * pass first would let a single satisfied mechanism vouch for a message another mechanism rejected.
 *
 * UNKNOWN IS NOT PASS. An empty header, a provider that sends none, a message polled before the
 * column existed: all unknown, and none of them may be read as a pass.
 *
 * tempprror and permerror are deliberately counted as failures: they mean the check could not be
 * completed, and "we could not verify" must not be rounded up to "verified".
 */
export function authVerdict(authResults: string | null | undefined): AuthVerdict {
  if (typeof authResults !== "string" || authResults.trim() === "") {
    return "unknown";
  }

  const text = authResults.toLowerCase();

  if (/\b(spf|dkim|dmarc)\s*=\s*(fail|softfail|temperror|permerror|policy)\b/.test(text)) {
    return "fail";
  }

  if (/\b(spf|dkim|dmarc)\s*=\s*pass\b/.test(text)) {
    return "pass";
  }

  return "unknown";
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

/**
 * The registrable domain ("eTLD+1") of a host, or null when there is not one.
 *
 * THE PUBLIC SUFFIX LIST IS THE POINT, NOT A DETAIL. The previous implementation took the last
 * two labels unconditionally, which is correct only when the last label is itself a registry.
 * On a two-label suffix like .co.uk it returned "co.uk" for EVERY such host, so
 * `jobs@talentagency.co.uk` registrable-domained to the same thing as the employer's
 * `northwind.co.uk` and domainsMatch() said yes. That is not a near miss: it is a fabricated
 * signal worth 0.5, enough to auto-link an unrelated email at 1.00 confidence.
 *
 * tldts carries the real list, so "co.uk", "com.au", "co.jp" and the ~9,000 others collapse
 * correctly, and a bare public suffix returns NULL — which domainsMatch() treats as "cannot
 * match", the fail-closed direction. `tldts` was already present in node_modules as a phantom
 * transitive dependency and is now declared; a hand-rolled list was rejected because it is
 * incomplete by construction and the failure mode is a silent false match.
 */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) {
    return null;
  }
  // allowPrivateDomains stays false: this only ever compares employer domains, and a private
  // suffix (github.io and friends) is never one.
  return getDomain(host.toLowerCase(), { allowPrivateDomains: false });
}

/**
 * KNOWN ATS VENDOR DOMAINS — the senders that relay an employer's mail.
 *
 * Deliberately a STRICT HAND-CURATED SET rather than a heuristic. A wrong entry here promotes an
 * exact company name from 0.35 to 0.65, so a stranger's domain that looked vendor-ish would be a
 * way to manufacture evidence. Every entry below is a vendor whose mail a candidate's inbox
 * genuinely receives; adding one is a reviewed change, not a guess.
 *
 * THIS LIST IS INCOMPLETE ON PURPOSE. A vendor that is missing falls back to the old behaviour -
 * a review-floor miss - which is a missing link rather than a wrong one. That is the direction to
 * fail in.
 */
export const ATS_RELAY_DOMAINS: ReadonlySet<string> = new Set([
  "greenhouse.io",
  "lever.co",
  "myworkdayjobs.com",
  "myworkdaysite.com",
  "workday.com",
  "ashbyhq.com",
  "icims.com",
  "smartrecruiters.com",
  "successfactors.com",
  "workable.com",
  "bamboohr.com",
  "recruitee.com",
  "jobvite.com",
  "paylocity.com",
  "brassring.com",
  "avature.net",
  "breezy.hr",
  "careerplug.com",
  "dayforcehcm.com",
  "oraclecloud.com",
  "jazzhr.com",
  "teamtailor.com",
  "rippling.com",
  "hireology.com",
  "phenom.com",
  "taleo.net",
  "join.com",
  "indeed.com",
]);

/**
 * What an exact company name is worth when the mail arrived from an ATS vendor.
 *
 * 0.65 CLEARS THE 0.60 REVIEW FLOOR AND STOPS SHORT OF THE 0.85 AUTO THRESHOLD, which is the
 * whole design. A relay sender's domain says nothing about WHICH application this is - the vendor
 * serves thousands of employers - so the name alone should put the email in front of a human, not
 * bind it automatically. Adding a role or a job id can still carry it over the auto line, and
 * that is right: those are independent pieces of evidence.
 */
export const RELAY_COMPANY_EXACT_WEIGHT = 0.65;

/**
 * What an exact ATS job id is worth.
 *
 * IT USED TO BE 0.95, WHICH AUTO-LINKED ON ITS OWN, AND THAT WAS WRONG: THE JOB ID IS PUBLIC.
 * It is displayed on the employer's own job board, so anyone who can see the posting can put it
 * in an email. An exact id therefore proves WHICH job this mail is about and nothing at all about
 * WHO sent it - and treating it as near-certain turned a public string into an auto-link.
 *
 * 0.70 CLEARS THE 0.60 REVIEW FLOOR AND STOPS SHORT OF THE 0.85 AUTO THRESHOLD, which is the same
 * shape the relay weight uses: enough to put the message in front of a human, not enough to bind
 * it without corroboration.
 */
export const JOB_ID_EXACT_WEIGHT = 0.7;

/**
 * Whether this sender is an ATS vendor relaying an employer's mail.
 *
 * Matched on the REGISTRABLE domain, so a tenant or regional subdomain is recognised as the same
 * vendor: `eu.greenhouse.io` and `acme.myworkdayjobs.com` both resolve to their vendor.
 */
export function isAtsRelay(sender: string | null | undefined): boolean {
  const host = senderDomain(sender);
  if (host === null) {
    return false;
  }
  const registrable = registrableDomain(host);
  return registrable !== null && ATS_RELAY_DOMAINS.has(registrable);
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
    confidence += JOB_ID_EXACT_WEIGHT;
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
    // THE NAME IS WORTH MORE WHEN A VENDOR VOUCHES FOR WHAT KIND OF MAIL THIS IS.
    //
    // It is not worth more because the vendor knows the employer - it does not, it serves
    // thousands. It is worth more because a vendor sender and an exact company name together
    // establish something neither does alone: this is an application-system notification about
    // THIS employer. Without it a relayed rejection scores 0.35 and is discarded, which is how
    // the commonest mail in the system was being thrown away.
    //
    // NOT ADDITIVE with company_name_exact: the relay grants 0.65 INSTEAD of 0.35. Stacking them
    // would reach 1.00 on a company name and a vendor domain alone, which is exactly the
    // confident-wrong-link this module was just fixed for.
    if (from !== null && isAtsRelay(input.sender)) {
      confidence += RELAY_COMPANY_EXACT_WEIGHT;
      reasons.push("relay_company_exact");
    } else {
      confidence += 0.35;
      reasons.push("company_name_exact");
    }
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
  // PROVENANCE THAT IS NOT A GUESS IS DECIDED FIRST.
  //
  // Everything below this block is arithmetic over strings an attacker can read off a job board.
  // A verified reply token is different in kind: it is a MAC of the attempt id, minted by us into
  // the address the reply was sent to, so it identifies ONE application rather than scoring
  // similar to several. It therefore bypasses the review threshold, the independence requirement
  // and the ambiguity margin - none of which are evidence about a lookup, and all of which would
  // otherwise downgrade a cryptographic certainty to a coin toss between identical scores.
  //
  // IT DOES NOT BYPASS A HARD AUTH FAILURE. The token says which application a message is ABOUT;
  // it says nothing about who sent it, and the address can be learned by anyone the reply reaches.
  // A failed SPF/DKIM/DMARC verdict is the receiving provider telling us it could not vouch for
  // the sender, so that case still goes to a human. "Fail wins" outranks even this.
  if (input.verifiedAttemptId) {
    const proven = apps.find((app) => app.attemptId === input.verifiedAttemptId);

    if (proven) {
      const candidate: ScoredApplication = {
        attemptId: proven.attemptId,
        confidence: 1,
        reasons: ["reply_token_verified"],
      };

      if (authVerdict(input.authResults) === "fail") {
        return { kind: "review", candidates: [candidate] };
      }

      return {
        kind: "auto",
        attemptId: proven.attemptId,
        confidence: 1,
        reasons: ["reply_token_verified"],
      };
    }

    // A verified id that is not among this candidate's applications is not evidence of anything
    // this function may act on. Fall through rather than link an attempt we were not shown.
  }

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

  // A SENDER DOMAIN DOES NOT COUNT TOWARD INDEPENDENCE - see MIN_INDEPENDENT_REASONS_FOR_AUTO.
  const independent = best.reasons.filter((reason) => reason !== "sender_domain_match");

  if (independent.length < MIN_INDEPENDENT_REASONS_FOR_AUTO) {
    return {
      kind: "review",
      candidates: scored.filter((s) => s.confidence >= MATCH_REVIEW_THRESHOLD),
    };
  }

  // PROVENANCE OVERRIDES SIMILARITY. A high score built from a company name, a role and a job id
  // can be assembled by anyone who can read a public job board; a failed SPF/DKIM verdict says the
  // sending domain could not be vouched for by the provider that received it. When those disagree,
  // the human decides - the score is not an argument against evidence about who sent the message.
  //
  // This runs BEFORE the ambiguity check on purpose: a failed verdict is disqualifying regardless
  // of how the field looks.
  if (authVerdict(input.authResults) === "fail") {
    return {
      kind: "review",
      candidates: scored.filter((s) => s.confidence >= MATCH_REVIEW_THRESHOLD),
    };
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
