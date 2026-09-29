/**
 * What the job action actually does, and what it must be called.
 *
 * WHY THIS EXISTS. The listing link used to be the job title and nothing else,
 * so the destination was unlabelled. A button labelled "Apply" over a URL that
 * is an aggregator's own page tells the candidate something untrue — that
 * clicking it applies for the job. It does not: it opens a page they must then
 * apply from by hand, if the aggregator even links onward to the employer.
 *
 * TWO KINDS, AND ONLY TWO:
 *
 *   employer_application — the vacancy's authoritative_url is the employer's OWN
 *     hosted application page, because the employer's applicant tracking system
 *     IS their system of record for applications. Greenhouse stores the board's
 *     own absolute_url for the posting and Lever stores the posting's hostedUrl
 *     (jobs.lever.co/<site>/<id>); both are the employer's application form, not
 *     a third party's description of the job.
 *
 *   source_listing — everything else. The URL belongs to the source that told us
 *     about the job (Remotive, The Muse, Arbeitnow, Jooble, SerpAPI/USAJOBS), and
 *     for these the honest verb is "open", not "apply". Remotive's terms require
 *     linking back to its own page rather than the employer's, so this is also
 *     the only URL we hold for them.
 *
 * THIS IS A LABEL, NOT A CAPABILITY, AND IT PERMITS NOTHING. Opening either kind
 * is a plain navigation. It does not queue an application, does not write a
 * status, and must never be presented as a submission. The automated-submission
 * question — whether JobBeacon may submit on the candidate's behalf — is a
 * separate gate (server/applications/eligibilityGate.ts) and is deliberately not
 * consulted here, because "the employer hosts an application form" says nothing
 * about whether we are authorised to fill it in.
 *
 * NOTHING HERE IS INFERRED FROM THE URL STRING. A URL that contains
 * "greenhouse.io" proves nothing about who controls it; the source_code is the
 * server's own record of which adapter ingested the row, so the decision keys on
 * that instead.
 */

export type JobLinkKind = "employer_application" | "source_listing";

export interface JobLinkDescription {
  kind: JobLinkKind;
  /** Shown to the candidate. Always states where the click goes. */
  label: string;
}

/**
 * Sources whose stored URL is the employer's own hosted application page.
 *
 * KEEP THIS TINY AND JUSTIFIED. A source belongs here only when the employer's
 * ATS hosts the posting AND that ATS is the employer's system of record for
 * applications — the same precondition adapters/registry.ts sets for treating a
 * source as a real submission channel. Adding a source here without that is
 * exactly the overclaiming this module exists to prevent.
 *
 * local_fixture is deliberately absent: it is a development fixture that submits
 * nowhere, and its [MOCK] rows are excluded from candidate listings anyway.
 */
const EMPLOYER_APPLICATION_SOURCES: ReadonlySet<string> = new Set(["greenhouse", "lever"]);

export const OPEN_ORIGINAL_POSTING_LABEL = "Open original job posting ↗";
export const APPLY_ON_EMPLOYER_SITE_LABEL = "Apply on employer site ↗";

export function describeJobLink(sourceCode: string): JobLinkDescription {
  if (EMPLOYER_APPLICATION_SOURCES.has(sourceCode)) {
    return { kind: "employer_application", label: APPLY_ON_EMPLOYER_SITE_LABEL };
  }

  return { kind: "source_listing", label: OPEN_ORIGINAL_POSTING_LABEL };
}

/**
 * The link's accessible name.
 *
 * WHY IT IS NOT JUST THE VISIBLE LABEL. "Open original job posting ↗" is the
 * same string on every row, so a screen-reader user hearing only that cannot tell
 * one job from another — and a list of identically-named links is the classic
 * accessibility failure for exactly this control. The name therefore carries the
 * job title and states that a new tab opens, because the arrow glyph is visual
 * only and announces as nothing.
 */
export function describeJobLinkAriaLabel(sourceCode: string, jobTitle: string): string {
  const { label } = describeJobLink(sourceCode);
  const title = jobTitle.trim() === "" ? "this job" : jobTitle.trim();

  return label + " — " + title + " (opens in a new tab)";
}
