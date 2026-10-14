import { describe, expect, it } from "vitest";
import { detectSite, SITE_PROFILES, type SiteProfile } from "./sites";

/**
 * These are the hosts the extension already declares in
 * extension/public/manifest.json. detectSite REFINES that list; it is not the
 * security boundary and must never be treated as one. The manifest's `matches`
 * is what decides whether this code runs at all, and it is deliberately narrow.
 */
describe("detectSite - the sites we can fill on", () => {
  it.each([
    ["https://boards.greenhouse.io/acme/jobs/1", "greenhouse"],
    ["https://job-boards.greenhouse.io/acme/jobs/1", "greenhouse"],
    ["https://jobs.lever.co/acme/abc-123", "lever"],
    ["https://acme.myworkdayjobs.com/en-US/careers/job/1", "workday"],
    ["https://www.workday.com/en-us/jobs/1", "workday"],
  ])("resolves %s to %s", (url, sourceCode) => {
    expect(detectSite(url)?.sourceCode).toBe(sourceCode);
  });

  it("returns undefined for a host that is not in the registry", () => {
    expect(detectSite("https://example.com/jobs/1")).toBeUndefined();
    expect(detectSite("https://indeed.com/viewjob?jk=1")).toBeUndefined();
  });

  it("does not match a LOOKALIKE host that merely ends with a pattern", () => {
    // A bare `includes` would resolve both of these to greenhouse and quietly
    // start offering to fill forms on a stranger's page.
    expect(detectSite("https://evilgreenhouse.io/acme/jobs/1")).toBeUndefined();
    expect(detectSite("https://notmyworkdayjobs.com/job/1")).toBeUndefined();
  });

  it("does not match a host that merely CONTAINS a pattern", () => {
    expect(detectSite("https://greenhouse.io.evil.test/acme/jobs/1")).toBeUndefined();
  });

  it("does not match a pattern that only appears in the query string", () => {
    // Query strings are attacker-controlled on any host. Matching them would let
    // a page nominate itself as a site we fill on.
    expect(detectSite("https://evil.test/?next=boards.greenhouse.io/acme")).toBeUndefined();
    expect(detectSite("https://evil.test/?gh_jid=1")).toBeUndefined();
  });

  it("returns undefined for an unparseable URL rather than throwing", () => {
    expect(detectSite("not a url")).toBeUndefined();
    expect(detectSite("")).toBeUndefined();
  });

  it("is deterministic: the same URL resolves to the same profile reference", () => {
    const url = "https://boards.greenhouse.io/acme/jobs/1";
    expect(detectSite(url)).toBe(detectSite(url));
  });
});

describe("detectSite - overlap resolution", () => {
  // Synthetic profiles: none of the shipped sites currently overlap, so the
  // ordering rule is pinned here with lists this test owns rather than by
  // inventing a collision in the real registry.
  const general: SiteProfile = {
    sourceCode: "general",
    displayName: "General",
    urlPatterns: ["greenhouse.io"],
  };
  const specific: SiteProfile = {
    sourceCode: "specific",
    displayName: "Specific",
    urlPatterns: ["boards.greenhouse.io"],
  };

  it("prefers the LONGER, more specific pattern regardless of registry order", () => {
    expect(detectSite("https://boards.greenhouse.io/x", [general, specific])?.sourceCode).toBe("specific");
    expect(detectSite("https://boards.greenhouse.io/x", [specific, general])?.sourceCode).toBe("specific");
  });

  it("still resolves the general host when only the general profile matches", () => {
    expect(detectSite("https://careers.greenhouse.io/x", [general, specific])?.sourceCode).toBe("general");
  });

  it("breaks an exact-length tie by registry order, so the result is never arbitrary", () => {
    const first: SiteProfile = { sourceCode: "first", displayName: "First", urlPatterns: ["same.test"] };
    const second: SiteProfile = { sourceCode: "second", displayName: "Second", urlPatterns: ["same.test"] };
    expect(detectSite("https://same.test/x", [first, second])?.sourceCode).toBe("first");
    expect(detectSite("https://same.test/x", [second, first])?.sourceCode).toBe("second");
  });
});

describe("SITE_PROFILES - invariants", () => {
  it("uses a unique sourceCode per profile", () => {
    const codes = SITE_PROFILES.map((p) => p.sourceCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("uses the shared lowercase snake_case source-code shape", () => {
    // These strings cross the wire and are matched against the server's own
    // source codes, so the shape is a contract rather than a style choice.
    for (const profile of SITE_PROFILES) {
      expect(profile.sourceCode).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("declares patterns as bare hostnames", () => {
    // A pattern carrying a scheme, a slash or a wildcard is not a hostname, and
    // this registry matches hostnames only. Rejecting them here keeps the
    // matching rule narrow enough to reason about.
    for (const profile of SITE_PROFILES) {
      expect(profile.urlPatterns.length).toBeGreaterThan(0);
      for (const pattern of profile.urlPatterns) {
        expect(pattern).toBe(pattern.toLowerCase());
        expect(pattern).not.toContain("://");
        expect(pattern).not.toContain("/");
        expect(pattern).not.toContain("*");
        expect(pattern).not.toContain("?");
      }
    }
  });

  it("carries only the agreed keys, so vendor colours and styling cannot creep in", () => {
    // The clean-room line, enforced instead of remembered: Tsenta's table stores
    // primaryColor/bgClass per ATS. That is exactly the visual styling this
    // codebase must not inherit, so the allowed key set is asserted.
    const allowed = new Set(["sourceCode", "displayName", "urlPatterns", "fieldOverrides"]);
    for (const profile of SITE_PROFILES) {
      for (const key of Object.keys(profile)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });
});
