import { describe, expect, it } from "vitest";
import { evaluatePositiveReasonCodes, type PositiveReasonCodeSignals } from "./positiveReasonCodes.js";

const baseSignals: PositiveReasonCodeSignals = {
  authoritativeUrl: "https://randomjobsite.example/post/999",
  companyDomain: null,
  companyCareerDomain: null,
  sourceCode: "adzuna",
  salarySource: null,
  vacancyStatus: "expired",
  lastSeenAt: "2026-08-01T00:00:00Z",
  now: "2026-08-17T00:00:00Z",
};

describe("evaluatePositiveReasonCodes", () => {
  it("returns no codes when nothing is confirmable", () => {
    expect(evaluatePositiveReasonCodes(baseSignals)).toEqual([]);
  });

  describe("OFFICIAL_CAREER_PAGE_CONFIRMED", () => {
    it("triggers when the hostname matches the career domain", () => {
      const signals: PositiveReasonCodeSignals = {
        ...baseSignals,
        authoritativeUrl: "https://careers.acme.com/jobs/1",
        companyCareerDomain: "careers.acme.com",
      };
      expect(evaluatePositiveReasonCodes(signals)).toContain("OFFICIAL_CAREER_PAGE_CONFIRMED");
    });

    it("does not trigger when no career domain is known", () => {
      const signals: PositiveReasonCodeSignals = { ...baseSignals, authoritativeUrl: "https://careers.acme.com/jobs/1" };
      expect(evaluatePositiveReasonCodes(signals)).not.toContain("OFFICIAL_CAREER_PAGE_CONFIRMED");
    });
  });

  describe("CORPORATE_DOMAIN_CONFIRMED", () => {
    it("triggers when the hostname matches the general company domain", () => {
      const signals: PositiveReasonCodeSignals = {
        ...baseSignals,
        authoritativeUrl: "https://jobs.acme.com/post/1",
        companyDomain: "acme.com",
      };
      expect(evaluatePositiveReasonCodes(signals)).toContain("CORPORATE_DOMAIN_CONFIRMED");
    });
  });

  it("can confirm both the career-page and corporate-domain codes together for a career subdomain", () => {
    const signals: PositiveReasonCodeSignals = {
      ...baseSignals,
      authoritativeUrl: "https://careers.acme.com/jobs/1",
      companyDomain: "acme.com",
      companyCareerDomain: "careers.acme.com",
    };
    const result = evaluatePositiveReasonCodes(signals);
    expect(result).toContain("OFFICIAL_CAREER_PAGE_CONFIRMED");
    expect(result).toContain("CORPORATE_DOMAIN_CONFIRMED");
  });

  describe("ATS_POSTING_CONFIRMED", () => {
    it.each(["greenhouse", "lever"])("triggers for source_code %s", (sourceCode) => {
      expect(evaluatePositiveReasonCodes({ ...baseSignals, sourceCode })).toContain("ATS_POSTING_CONFIRMED");
    });

    it.each(["usajobs", "adzuna"])("does not trigger for source_code %s", (sourceCode) => {
      expect(evaluatePositiveReasonCodes({ ...baseSignals, sourceCode })).not.toContain("ATS_POSTING_CONFIRMED");
    });
  });

  describe("RECENT_SOURCE_RECHECK_PASSED", () => {
    it("triggers for an active vacancy last seen within 24 hours", () => {
      const signals: PositiveReasonCodeSignals = {
        ...baseSignals,
        vacancyStatus: "active",
        lastSeenAt: "2026-08-17T00:00:00Z",
        now: "2026-08-17T01:00:00Z",
      };
      expect(evaluatePositiveReasonCodes(signals)).toContain("RECENT_SOURCE_RECHECK_PASSED");
    });

    it("does not trigger beyond the 24-hour window", () => {
      const signals: PositiveReasonCodeSignals = {
        ...baseSignals,
        vacancyStatus: "active",
        lastSeenAt: "2026-08-14T00:00:00Z",
        now: "2026-08-17T00:00:00Z",
      };
      expect(evaluatePositiveReasonCodes(signals)).not.toContain("RECENT_SOURCE_RECHECK_PASSED");
    });

    it("does not trigger for a non-active vacancy even if recently seen", () => {
      const signals: PositiveReasonCodeSignals = {
        ...baseSignals,
        vacancyStatus: "expired",
        lastSeenAt: "2026-08-17T00:00:00Z",
        now: "2026-08-17T01:00:00Z",
      };
      expect(evaluatePositiveReasonCodes(signals)).not.toContain("RECENT_SOURCE_RECHECK_PASSED");
    });
  });

  describe("SALARY_EMPLOYER_DISCLOSED", () => {
    it("triggers when salary_source is employer_disclosed", () => {
      expect(evaluatePositiveReasonCodes({ ...baseSignals, salarySource: "employer_disclosed" })).toContain(
        "SALARY_EMPLOYER_DISCLOSED",
      );
    });

    it("does not trigger for an estimated salary", () => {
      expect(evaluatePositiveReasonCodes({ ...baseSignals, salarySource: "estimated" })).not.toContain(
        "SALARY_EMPLOYER_DISCLOSED",
      );
    });
  });

  it("returns every confirmable code together for a fully favorable vacancy", () => {
    const signals: PositiveReasonCodeSignals = {
      authoritativeUrl: "https://careers.acme.com/jobs/1",
      companyDomain: "acme.com",
      companyCareerDomain: "careers.acme.com",
      sourceCode: "greenhouse",
      salarySource: "employer_disclosed",
      vacancyStatus: "active",
      lastSeenAt: "2026-08-17T00:00:00Z",
      now: "2026-08-17T01:00:00Z",
    };
    const result = evaluatePositiveReasonCodes(signals);
    expect(result).toEqual(
      expect.arrayContaining([
        "OFFICIAL_CAREER_PAGE_CONFIRMED",
        "CORPORATE_DOMAIN_CONFIRMED",
        "ATS_POSTING_CONFIRMED",
        "RECENT_SOURCE_RECHECK_PASSED",
        "SALARY_EMPLOYER_DISCLOSED",
      ]),
    );
    expect(result).toHaveLength(5);
  });
});
