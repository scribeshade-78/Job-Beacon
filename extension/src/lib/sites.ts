import type { CandidateProfile } from "./types.js";

/**
 * The sites the extension knows by name, as DATA rather than as branches.
 *
 * ONE IMPLEMENTATION PER SITE, RESOLVED BY sourceCode — the same convention
 * server/applications/adapters/registry.ts uses for submission channels. A site
 * is added by adding an entry here, not by adding a case to a function.
 *
 * THIS IS A REFINEMENT, NOT A SECURITY BOUNDARY. The extension only runs at all
 * on the hosts declared in extension/public/manifest.json, and that manifest
 * list is deliberately narrow. detectSite answers "which of the hosts we are
 * already allowed on is this?" — it must never be the thing that decides whether
 * a page is trusted.
 *
 * DETECTION IS GENERIC-FIRST. The field filler in content.ts matches on
 * autocomplete, then type, then surrounding text, and those signals are far more
 * robust across ATSs than any per-site table. A profile therefore carries
 * OVERRIDES, tried only after the generic ladder misses — it does not replace
 * that ladder. Tsenta's equivalent registry holds ordered XPath fallbacks per
 * field, and that is the brittle 48-entry shape this design exists to avoid.
 *
 * WHAT IS DELIBERATELY ABSENT. No primaryColor, no bgClass, no logo, no font.
 * Tsenta's table carries per-ATS brand colours ("#38B2AC", "bg-teal-100") for
 * badge rendering. That is visual styling, this codebase has its own tokens in
 * client/src/styles.css, and the allowed key set is asserted in
 * sites.test.ts so it cannot creep back in.
 */

/** A profile field is a CandidateProfile key, so the two cannot drift apart. */
export type ProfileField = keyof CandidateProfile;

export interface SiteProfile {
  /**
   * The shared identity for this site.
   *
   * These strings cross the wire and are matched against the server's own
   * source codes (server/ats/credentials.ts's ATS_SOURCE_CODES), so
   * server/applications/adapters/siteRegistryParity.test.ts asserts that every
   * source the server can submit to has a profile here using the identical
   * string.
   */
  sourceCode: string;
  displayName: string;
  /**
   * Bare lowercase hostnames. A host matches when it IS the pattern or is a
   * subdomain of it — see hostMatches. Schemes, paths, wildcards and query
   * strings are rejected by the invariant test in sites.test.ts.
   */
  urlPatterns: string[];
  /**
   * Last-resort selectors for a site the generic ladder gets wrong.
   *
   * NO SHIPPED PROFILE DECLARES ONE, and that is the honest state: an override
   * is added when a specific site has been shown to need it, with a test that
   * pins the behaviour. Nothing here is speculative.
   */
  fieldOverrides?: Partial<Record<ProfileField, RegExp[]>>;
}

/**
 * Whether a hostname is the pattern itself or a subdomain of it.
 *
 * THE BOUNDARY CHECK IS THE WHOLE POINT. A bare includes() resolves
 * "evilgreenhouse.io" and "notmyworkdayjobs.com" to real ATSs, and the
 * extension would then start offering to fill forms on hosts nobody vetted.
 */
function hostMatches(hostname: string, pattern: string): boolean {
  const lowerPattern = pattern.toLowerCase();
  if (hostname === lowerPattern) {
    return true;
  }
  return hostname.endsWith("." + lowerPattern);
}

/**
 * The profile for a URL, or undefined when the host is not one we know.
 *
 * A pure function of its arguments: no browser, no network, no module state, so
 * every rule below is testable without a page. The profiles argument exists so
 * the overlap rule can be pinned against a list a test owns rather than by
 * inventing a collision in the shipped registry.
 *
 * UNDEFINED IS THE COMMON CASE AND THE SAFE ONE — the same stance readAttemptId
 * takes. Most pages are not job boards, and a site we do not recognise must
 * produce no action at all rather than a guess.
 */
export function detectSite(raw: string, profiles: readonly SiteProfile[] = SITE_PROFILES): SiteProfile | undefined {
  let hostname: string;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    return undefined;
  }

  if (hostname === "") {
    return undefined;
  }

  const host = hostname.toLowerCase();

  let best: SiteProfile | undefined;
  let bestLength = -1;

  for (const profile of profiles) {
    for (const pattern of profile.urlPatterns) {
      if (!hostMatches(host, pattern)) {
        continue;
      }

      // LONGEST PATTERN WINS, so a specific profile can refine a general one
      // without depending on declaration order. Strictly greater, so an
      // exact-length tie is broken deterministically by registry order instead
      // of by whichever entry happened to be visited last.
      if (pattern.length > bestLength) {
        best = profile;
        bestLength = pattern.length;
      }
    }
  }

  return best;
}

/**
 * The registry.
 *
 * Scoped to exactly the hosts extension/public/manifest.json already declares.
 * Growing it is one entry here plus one host pattern there, reviewed together —
 * NOT a move to <all_urls>, which is what Tsenta's overlay uses and what this
 * codebase is deliberately not doing.
 *
 * workday IS FILL-ONLY, AND THAT IS NOT DRIFT. The server has no submission
 * channel for it (ATS_SOURCE_CODES is greenhouse and lever), so it will never
 * appear in that list. The extension fills the form and the candidate submits,
 * which needs no server-side channel — a capability difference, not an
 * inconsistency. The parity test allows exactly this.
 */
export const SITE_PROFILES: readonly SiteProfile[] = [
  {
    sourceCode: "greenhouse",
    displayName: "Greenhouse",
    // Covers both boards.greenhouse.io and job-boards.greenhouse.io, and any
    // future subdomain, because they are all Greenhouse.
    urlPatterns: ["greenhouse.io"],
  },
  {
    sourceCode: "lever",
    displayName: "Lever",
    urlPatterns: ["lever.co"],
  },
  {
    sourceCode: "workday",
    displayName: "Workday",
    // Real Workday postings live on a tenant subdomain of myworkdayjobs.com
    // (acme.wd1.myworkdayjobs.com), so the subdomain rule is what makes this
    // match in practice.
    //
    // myworkdaysite.com IS DELIBERATELY ABSENT. It is a genuine Workday domain and Tsenta
    // carries it, but extension/public/manifest.json does not declare it, so the content
    // script never runs there and a profile for it would be unreachable. The alternative
    // was a new host permission for coverage nobody asked for, and
    // verify-build.mjs now fails the build on exactly this mismatch.
    urlPatterns: ["myworkdayjobs.com", "workday.com"],
  },
];
