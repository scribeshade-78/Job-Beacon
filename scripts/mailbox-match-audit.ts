#!/usr/bin/env node
/**
 * scripts/mailbox-match-audit.ts — what does the application matcher actually decide on realistic mail?
 *
 * WHY THIS EXISTS. scoreApplicationMatch is a pure function with published thresholds, and reading it
 * tells you the weights but not what they DO. The combination arithmetic is the whole behaviour: a
 * signal worth 0.35 is invisible below a 0.60 review floor no matter how correct it is, and two
 * individually-reasonable weights can land exactly on a threshold. This runs the real function over a
 * realistic candidate's applications and realistic recruiter mail, prints the scoreboard, and marks
 * every case where the CURRENT behaviour differs from what the product would want.
 *
 * PURE, SO NO DATABASE AND NO MODEL. The matcher takes its applications as an argument, and the
 * entity extraction (company / role / job id) happens upstream in the LLM classifier. The extraction
 * is therefore SIMULATED here from the email text - this audits the SCORING, not the classifier.
 * Every simulated extraction is written out so a reader can disagree with it.
 *
 *   node --import=tsx scripts/mailbox-match-audit.ts
 *
 * Exit code is 0 when the engine behaves as documented and 1 when a case diverges, so this can be
 * wired into a gate later if the divergences are ever fixed or deliberately accepted.
 */

import {
  MATCH_AMBIGUITY_MARGIN,
  MATCH_AUTO_THRESHOLD,
  MATCH_REVIEW_THRESHOLD,
  scoreApplicationMatch,
  type CandidateApplication,
  type MatchInput,
  type MatchResult,
  type ScoredApplication,
} from "../server/mailbox/matchApplication.js";

/** A realistic in-flight set for one candidate: three US employers and two UK ones. */
const APPLICATIONS: CandidateApplication[] = [
  {
    attemptId: "attempt-stripe",
    companyName: "Stripe, Inc.",
    companyDomain: "stripe.com",
    careerDomain: "stripe.com",
    roleTitle: "Backend Engineer",
    sourceVacancyId: "gh-7712345",
  },
  {
    attemptId: "attempt-vercel",
    companyName: "Vercel",
    companyDomain: "vercel.com",
    careerDomain: "vercel.com",
    roleTitle: "Senior Frontend Engineer",
    sourceVacancyId: "gh-8891002",
  },
  {
    attemptId: "attempt-anthropic",
    companyName: "Anthropic",
    companyDomain: "anthropic.com",
    careerDomain: "anthropic.com",
    roleTitle: "Software Engineer, Infrastructure",
    sourceVacancyId: "ashby-901",
  },
  {
    attemptId: "attempt-northwind",
    companyName: "Northwind Analytics Ltd",
    companyDomain: "northwind.co.uk",
    careerDomain: "northwind.co.uk",
    roleTitle: "Data Engineer",
    sourceVacancyId: "lever-55123",
  },
  {
    attemptId: "attempt-brighton",
    companyName: "Brighton Robotics Ltd",
    companyDomain: "brightonrobotics.co.uk",
    careerDomain: "brightonrobotics.co.uk",
    roleTitle: "Embedded Engineer",
    sourceVacancyId: "lever-77881",
  },
];

interface MailCase {
  label: string;
  from: string;
  subject: string;
  /** What an LLM classifier would plausibly pull out of the body. Simulated; see the header. */
  extraction: { company: string | null; role: string | null; jobId: string | null };
  /** What the product would WANT. When this differs from the result, it is a finding. */
  desired: "auto" | "review" | "ambiguous" | "none";
  desiredAttemptId?: string;
  /** Why the divergence matters, printed alongside it so the output explains itself. */
  finding?: string;
}

const CASES: MailCase[] = [
  {
    label: "A. Clear interview invite, ATS job id in the body",
    from: "Stripe Recruiting <no-reply@stripe.com>",
    subject: "Interview invitation for Backend Engineer (Req gh-7712345)",
    extraction: { company: "Stripe", role: "Backend Engineer", jobId: "gh-7712345" },
    desired: "auto",
    desiredAttemptId: "attempt-stripe",
  },
  {
    label: "B. Interview invite naming only the company (no role, no req id)",
    from: "Anthropic Recruiting <recruiting@anthropic.com>",
    subject: "Next steps for your application",
    extraction: { company: "Anthropic", role: null, jobId: null },
    desired: "auto",
    desiredAttemptId: "attempt-anthropic",
  },
  {
    label: "C. GENERIC REJECTION via an ATS relay, naming the company",
    from: "Stripe via Greenhouse <no-reply@greenhouse.io>",
    subject: "Update on your application to Stripe",
    extraction: { company: "Stripe", role: null, jobId: null },
    desired: "review",
    finding:
      "company_name_exact is worth 0.35, below the 0.60 review floor, and an ATS relay means the " +
      "sender domain never matches the employer. A rejection that names the company is silently " +
      "unmatched - and a rejection is the most common mail this engine will ever see.",
  },
  {
    label: "D. Ambiguous: role only, from the employer's own recruiting domain",
    from: "Northwind Analytics <talent@northwind.co.uk>",
    subject: "Your Data Engineer application",
    extraction: { company: null, role: "Data Engineer", jobId: null },
    desired: "review",
  },
  {
    label: "E. UNRELATED UK AGENCY, same .co.uk suffix as two employers",
    from: "Talent Agency <jobs@talentagency.co.uk>",
    subject: "Opportunity: Data Engineer",
    extraction: { company: "Northwind Analytics", role: "Data Engineer", jobId: null },
    desired: "none",
    finding:
      "registrableDomain is the last two labels, so EVERY .co.uk host registrable-domains to " +
      "'co.uk'. An unrelated UK agency therefore earns sender_domain_match, and with company and " +
      "role exact that reaches 1.00 - a false AUTO at maximum confidence on a wrong application. " +
      "The source comment acknowledges foo.co.uk; this is what that costs.",
  },
];

function describeResult(result: MatchResult): string {
  // A local formatter rather than JSON.stringify, so a review candidate list reads as a table.
  if (result.kind !== "auto" && result.kind !== "none") {
    return result.kind + " -> " + result.candidates.map((c) => c.attemptId + " (" + c.confidence.toFixed(2) + ")").join(", ");
  }
  if (result.kind === "auto") {
    return "auto -> " + result.attemptId + " (" + result.confidence.toFixed(2) + ": " + result.reasons.join(", ") + ")";
  }
  return "none";
}

/**
 * The engine exposes a score ONLY when it clears the review floor: anything lower comes back as
 * { kind: "none" } with the number discarded. Every single signal except an exact job id sits below
 * that floor, so reading the weights off one-signal probes is impossible - they all report "none".
 *
 * SO THE WEIGHTS ARE SOLVED FROM OBSERVABLE PAIRS. Three probes, each a pair of signals, give three
 * equations in three unknowns; averaging them recovers the individual weights. That is measurement
 * rather than quotation, and it is the only route the public API allows.
 */
function confidenceFor(input: MatchInput, app: CandidateApplication): number | null {
  const result = scoreApplicationMatch(input, [app]);
  if (result.kind === "auto") return result.confidence;
  if (result.kind === "review" || result.kind === "ambiguous") {
    return result.candidates[0]?.confidence ?? null;
  }
  // Below the floor. Unknown, NOT zero - reporting 0.00 here would be inventing evidence.
  return null;
}

const stripe = APPLICATIONS[0]!;
const northwind = APPLICATIONS[3]!;

const senderPlusCompany = confidenceFor({ sender: "x@stripe.com", company: "Stripe", role: null, jobId: null }, stripe);
const senderPlusRole = confidenceFor({ sender: "x@northwind.co.uk", company: null, role: "Data Engineer", jobId: null }, northwind);
const companyPlusRole = confidenceFor({ sender: null, company: "Stripe", role: "Backend Engineer", jobId: null }, stripe);

if (senderPlusCompany === null || senderPlusRole === null || companyPlusRole === null) {
  console.error("A pairwise probe fell below the review floor, so the weights cannot be solved.");
  process.exit(1);
}

const senderWeight = (senderPlusCompany + senderPlusRole - companyPlusRole) / 2;
const companyWeight = (senderPlusCompany + companyPlusRole - senderPlusRole) / 2;
const roleWeight = (senderPlusRole + companyPlusRole - senderPlusCompany) / 2;
const jobIdWeight = confidenceFor({ sender: null, company: null, role: null, jobId: "gh-7712345" }, stripe) ?? 0;

console.log("=== THE WEIGHTS, SOLVED FROM OBSERVABLE PAIRS ===");
console.log("The engine hides any score below the review floor, so the weights cannot be read directly.");
console.log("Three paired probes give three equations; the individual weights fall out of them.");
console.log("");
console.log("  sender + company_exact  = " + senderPlusCompany.toFixed(2));
console.log("  sender + role_exact     = " + senderPlusRole.toFixed(2));
console.log("  company_exact + role_exact = " + companyPlusRole.toFixed(2));
console.log("");
const weightRows: Array<[string, number]> = [
  ["job_id_exact", jobIdWeight],
  ["sender_domain_match", senderWeight],
  ["company_name_exact", companyWeight],
  ["role_title_exact", roleWeight],
];
for (const [reason, weight] of weightRows) {
  const clears = weight >= MATCH_REVIEW_THRESHOLD;
  console.log("  " + reason.padEnd(22) + " = " + weight.toFixed(2) + "   " + (clears ? "clears the review floor alone" : "BELOW the " + MATCH_REVIEW_THRESHOLD + " review floor"));
}
console.log("");
console.log("  THE STRUCTURAL POINT: every signal except an exact job id is worth less than the review");
console.log("  floor on its own. One correct signal is never enough - only combinations link anything.");
console.log("  A pairing clears the floor from " + MATCH_REVIEW_THRESHOLD + ", and auto needs " + MATCH_AUTO_THRESHOLD + ".");
console.log("");
console.log("=== THRESHOLDS ===");
console.log("  auto     : confidence >= " + MATCH_AUTO_THRESHOLD);
console.log("  review   : " + MATCH_REVIEW_THRESHOLD + " <= confidence < " + MATCH_AUTO_THRESHOLD);
console.log("  ambiguous: two applications both above auto and within " + MATCH_AMBIGUITY_MARGIN + " of each other");
console.log("  none     : nothing scored at or above " + MATCH_REVIEW_THRESHOLD);
console.log("");

let divergences = 0;

for (const mail of CASES) {
  const input: MatchInput = {
    sender: mail.from,
    company: mail.extraction.company,
    role: mail.extraction.role,
    jobId: mail.extraction.jobId,
  };

  const result = scoreApplicationMatch(input, APPLICATIONS);

  // The full scoreboard, including applications the result itself does not surface. Applications
  // below the floor are reported as "below floor" rather than 0.00, because the engine does not
  // disclose their score and printing a zero would be inventing one.
  const scoreboard = APPLICATIONS
    .map((app) => ({ app, confidence: confidenceFor(input, app) }))
    .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));

  const got = result.kind;
  const diverges = got !== mail.desired;
  if (diverges) divergences += 1;

  console.log((diverges ? "  [DIVERGES] " : "  [matches]  ") + mail.label);
  console.log("      from        : " + mail.from);
  console.log("      extracted   : company=" + JSON.stringify(mail.extraction.company) +
    " role=" + JSON.stringify(mail.extraction.role) + " jobId=" + JSON.stringify(mail.extraction.jobId));
  console.log("      result      : " + describeResult(result));
  console.log("      expected    : " + mail.desired + (mail.desiredAttemptId ? " -> " + mail.desiredAttemptId : ""));
  if (diverges && mail.finding) {
    console.log("      FINDING     : " + mail.finding);
  }
  const visible = scoreboard.filter((row) => row.confidence !== null);
  const hidden = scoreboard.length - visible.length;
  console.log("      scoreboard  : " + (visible.length === 0
    ? "every application is below the " + MATCH_REVIEW_THRESHOLD + " review floor"
    : visible.map((row) => row.app.attemptId.replace("attempt-", "") + "=" + row.confidence!.toFixed(2)).join("  ") +
      (hidden > 0 ? "   (+" + hidden + " below the floor)" : "")));
  console.log("");
}

console.log("=== VERDICT ===");
console.log("  divergences from the product's intent: " + divergences + " of " + CASES.length);
process.exitCode = divergences === 0 ? 0 : 1;
