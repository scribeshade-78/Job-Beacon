import { ATTEMPT_PARAM } from "./loop.js";

/**
 * URL identity: one job, one key.
 *
 * The same posting reaches a candidate by a different URL every time it is
 * shared. A LinkedIn share carries utm_*, a Greenhouse embed carries gh_src, a
 * Lever listing carries leverappid, and a newsletter carries mc_cid. If that
 * campaign noise reaches the identity we keep, one job looks like five
 * applications, and every attempt-scoped decision downstream is made against the
 * wrong key.
 *
 * So this strips the noise and NOTHING else. It does not rewrite the path, drop
 * the fragment or reorder what is left, because every one of those is a change
 * to a URL we did not create and cannot see the other end of.
 */

/**
 * Campaign prefixes, matched by prefix rather than enumerated.
 *
 * An exhaustive list of utm_* tags goes stale the first time a new one ships and
 * fails SILENTLY when it does — the tag survives, identity quietly forks, and
 * nothing reports it. A prefix rule cannot go stale that way.
 */
export const TRACKING_PARAM_PREFIXES = ["utm_", "mc_"] as const;

/**
 * Named parameters that identify an arrival route rather than a job.
 *
 * These are the ATS source tags (gh_src, leverappid, lever-source) sitting
 * beside the click ids (fbclid, gclid, msclkid) on purpose: from an identity
 * point of view they are the same kind of thing — where the click came from —
 * and both are useless for telling two jobs apart.
 *
 * ENTRIES MUST BE LOWERCASE. isTrackingParam lowercases the name it is given
 * before consulting this set, so a mixed-case entry here would simply never
 * match.
 */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "gh_src",
  "greenhouse_src",
  "leverappid",
  "lever-source",
  "ref",
  "referrer",
  "referer",
  "source",
  "src",
  "fbclid",
  "gclid",
  "msclkid",
  "igshid",
  "feature",
  "tag",
  "trk",
  "trkinfo",
  "origin",
  "originplatform",
  "pid",
]);

/**
 * Whether a query parameter is campaign noise rather than job identity.
 *
 * Matching is exact for names and boundary-anchored for prefixes, never a bare
 * substring: "sourcery", "src2" and "xutm_source" are real fields, and eating
 * one of those is a worse failure than leaving a tracking tag behind.
 */
export function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();

  // THE ATTEMPT ID IS EXCLUDED BY IDENTITY, NOT BY ABSENCE FROM THE LIST.
  //
  // It must survive every canonicalization, because without it the content
  // script cannot tell which attempt a page belongs to and deliberately does
  // nothing at all when it cannot tell. Deriving that guarantee from "nobody has
  // added it to TRACKING_PARAMS yet" would make it a coincidence; comparing
  // against the tracker's own constant makes it a rule, and it keeps working if
  // the parameter is ever renamed.
  if (lower === ATTEMPT_PARAM) {
    return false;
  }

  if (TRACKING_PARAMS.has(lower)) {
    return true;
  }

  return TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * The canonical form of a job URL: campaign parameters removed, everything else
 * preserved exactly.
 *
 * AN UNPARSEABLE URL IS RETURNED UNCHANGED, not thrown on — the same stance
 * readAttemptId takes. The caller is a content script looking at whatever the
 * browser put in the address bar, and a string this cannot read is not this
 * function's problem to report. Throwing here would take down a fill that had
 * nothing to do with the URL.
 */
export function canonicalizeJobUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  // Snapshot the keys first. URLSearchParams allows a repeated key, and mutating
  // while iterating it is exactly how one value of a duplicated tracking tag
  // gets skipped.
  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParam(name)) {
      // delete() removes every value for the key, which is the behaviour we want
      // for a duplicated fbclid.
      url.searchParams.delete(name);
    }
  }

  return url.toString();
}
