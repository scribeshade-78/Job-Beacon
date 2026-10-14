import { describe, expect, it } from "vitest";
import { canonicalizeJobUrl, isTrackingParam, TRACKING_PARAMS } from "./url";
import { ATTEMPT_PARAM } from "./loop";

/**
 * The point of canonicalization is that ONE job has ONE key. The same posting
 * opened from a LinkedIn share, a Greenhouse embed and a newsletter all carry
 * different query junk, and if that junk reaches the identity we keep, they read
 * as three different applications.
 */
describe("isTrackingParam", () => {
  it("treats utm_* and mc_* as tracking by PREFIX, not by an exhaustive list", () => {
    // A prefix rule is what makes this survive new campaign tags. An enumerator
    // would silently stop working the first time a new one shipped.
    expect(isTrackingParam("utm_source")).toBe(true);
    expect(isTrackingParam("utm_campaign")).toBe(true);
    expect(isTrackingParam("utm_something_invented_next_year")).toBe(true);
    expect(isTrackingParam("mc_eid")).toBe(true);
    expect(isTrackingParam("mc_cid")).toBe(true);
  });

  it("treats the ATS and click ids as tracking by NAME", () => {
    expect(isTrackingParam("gh_src")).toBe(true);
    expect(isTrackingParam("greenhouse_src")).toBe(true);
    expect(isTrackingParam("leverappid")).toBe(true);
    expect(isTrackingParam("lever-source")).toBe(true);
    expect(isTrackingParam("fbclid")).toBe(true);
    expect(isTrackingParam("gclid")).toBe(true);
    expect(isTrackingParam("msclkid")).toBe(true);
  });

  it("is case-insensitive, because campaign tags are not typed consistently", () => {
    expect(isTrackingParam("UTM_SOURCE")).toBe(true);
    expect(isTrackingParam("Gh_Src")).toBe(true);
  });

  it("NEVER treats the attempt id as tracking", () => {
    // Asserted on the constant rather than a literal, so the guarantee moves with
    // the tracker's parameter name instead of silently going stale beside it.
    expect(ATTEMPT_PARAM).toBe("jb_attempt_id");
    expect(isTrackingParam(ATTEMPT_PARAM)).toBe(false);
    expect(TRACKING_PARAMS.has(ATTEMPT_PARAM)).toBe(false);
  });

  it("does not match a parameter that merely CONTAINS a tracking name", () => {
    // Substring matching here would eat real fields, which is a worse failure
    // than leaving one tracking tag behind.
    expect(isTrackingParam("sourcery")).toBe(false);
    expect(isTrackingParam("src2")).toBe(false);
    expect(isTrackingParam("xutm_source")).toBe(false);
    expect(isTrackingParam("reference")).toBe(false);
    expect(isTrackingParam("utm")).toBe(false);
  });
});

describe("canonicalizeJobUrl", () => {
  it("strips the ATS source tag that made two links to one job look different", () => {
    expect(
      canonicalizeJobUrl("https://boards.greenhouse.io/acme/jobs/1?gh_src=x&utm_source=y&jb_attempt_id=abc-123"),
    ).toBe("https://boards.greenhouse.io/acme/jobs/1?jb_attempt_id=abc-123");
  });

  it("KEEPS jb_attempt_id even when every parameter around it is stripped", () => {
    // This is the one parameter that must survive: without it the content script
    // cannot tell which attempt the page belongs to, and it deliberately does
    // nothing at all when it cannot tell.
    expect(canonicalizeJobUrl("https://jobs.lever.co/acme/abc?jb_attempt_id=abc&utm_source=x")).toBe(
      "https://jobs.lever.co/acme/abc?jb_attempt_id=abc",
    );
  });

  it("keeps ordinary parameters, in their original order", () => {
    expect(canonicalizeJobUrl("https://x.test/j?gh_jid=42&utm_source=a&page=2&fbclid=b&view=list")).toBe(
      "https://x.test/j?gh_jid=42&page=2&view=list",
    );
  });

  it("drops every value of a repeated tracking key", () => {
    expect(canonicalizeJobUrl("https://x.test/j?fbclid=a&fbclid=b&keep=1")).toBe("https://x.test/j?keep=1");
  });

  it("matches tracking names case-insensitively", () => {
    expect(canonicalizeJobUrl("https://x.test/j?UTM_SOURCE=a&Gh_Src=b&keep=1")).toBe("https://x.test/j?keep=1");
  });

  it("leaves a parameter that only looks like a tracking name", () => {
    expect(canonicalizeJobUrl("https://x.test/j?utm=a&xutm_source=b&sourcery=c")).toBe(
      "https://x.test/j?utm=a&xutm_source=b&sourcery=c",
    );
  });

  it("preserves the fragment, which some ATSs use to address a step", () => {
    expect(canonicalizeJobUrl("https://x.test/j?utm_source=a&keep=1#apply")).toBe("https://x.test/j?keep=1#apply");
  });

  it("normalizes the host so two casings of one job produce one key", () => {
    expect(canonicalizeJobUrl("https://X.Test/J?a=1")).toBe("https://x.test/J?a=1");
  });

  it("returns an unparseable URL unchanged rather than throwing", () => {
    // Same stance as readAttemptId: a string we cannot read is not this
    // function's problem to report, and throwing would take a caller down.
    expect(canonicalizeJobUrl("not a url")).toBe("not a url");
    expect(canonicalizeJobUrl("")).toBe("");
  });

  it("is idempotent, so canonicalizing twice is the same as once", () => {
    const once = canonicalizeJobUrl("https://x.test/j?utm_source=a&gh_src=b&keep=1&jb_attempt_id=abc");
    expect(canonicalizeJobUrl(once)).toBe(once);
  });
});
