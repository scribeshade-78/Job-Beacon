import { describe, expect, it } from "vitest";
import {
  applyOpportunityFilters,
  hasActiveOpportunityFilters,
  matchesWorkplaceFilter,
  NO_OPPORTUNITY_FILTERS,
  workplaceLabel,
} from "./opportunityFilters";
import type { OpportunitySummary } from "./opportunities";

function opportunity(remoteType: string | null): OpportunitySummary {
  return {
    id: "vac-1",
    title: "Data Engineer",
    url: "https://example.test/job/1",
    companyName: "Acme",
    companyDomain: null,
    location: "US",
    remoteType,
    trustStatus: "VERIFIED",
    sourceCode: "greenhouse",
    salary: { min: null, max: null, currency: null, interval: null, source: null },
    discoveredAt: "2026-09-17T00:00:00Z",
    lastSeenAt: "2026-09-17T00:00:00Z",
    autoApplyStatus: "not_started",
    fitAnalysis: null,
  };
}

describe("matchesWorkplaceFilter", () => {
  it("passes every row when nothing is selected", () => {
    expect(matchesWorkplaceFilter(opportunity(null), [])).toBe(true);
    expect(matchesWorkplaceFilter(opportunity("Remote"), [])).toBe(true);
  });

  it("matches case-insensitively and by containment", () => {
    expect(matchesWorkplaceFilter(opportunity("Remote"), ["remote"])).toBe(true);
    expect(matchesWorkplaceFilter(opportunity("Fully Remote"), ["remote"])).toBe(true);
    expect(matchesWorkplaceFilter(opportunity("  REMOTE  "), ["remote"])).toBe(true);
  });

  it("treats on-site and onsite as the same value", () => {
    expect(matchesWorkplaceFilter(opportunity("On-site"), ["on-site"])).toBe(true);
    expect(matchesWorkplaceFilter(opportunity("onsite"), ["on-site"])).toBe(true);
  });

  it("does not match a different workplace type", () => {
    expect(matchesWorkplaceFilter(opportunity("Hybrid"), ["remote"])).toBe(false);
    expect(matchesWorkplaceFilter(opportunity("Remote"), ["hybrid"])).toBe(false);
  });

  it("matches no option when remote_type is null or blank, rather than guessing", () => {
    // This is the honest behaviour behind "selecting Workplace can return
    // zero rows": every remote_type in the current corpus is null, and an
    // unknown value must not be silently bucketed into a real one.
    expect(matchesWorkplaceFilter(opportunity(null), ["remote"])).toBe(false);
    expect(matchesWorkplaceFilter(opportunity(""), ["remote"])).toBe(false);
    expect(matchesWorkplaceFilter(opportunity("   "), ["remote"])).toBe(false);
  });

  it("unions multiple selected options", () => {
    expect(matchesWorkplaceFilter(opportunity("Hybrid"), ["remote", "hybrid"])).toBe(true);
    expect(matchesWorkplaceFilter(opportunity("Remote"), ["remote", "hybrid"])).toBe(true);
    expect(matchesWorkplaceFilter(opportunity("On-site"), ["hybrid", "on-site"])).toBe(true);
    expect(matchesWorkplaceFilter(opportunity("On-site"), ["remote", "hybrid"])).toBe(false);
  });
});

describe("workplaceLabel", () => {
  it("renders the stored on_site value as the UI's On-site", () => {
    // The exact case that would otherwise leak the raw column value into
    // candidate-facing copy.
    expect(workplaceLabel("on_site")).toBe("On-site");
  });

  it("renders the other stored values in UI casing", () => {
    expect(workplaceLabel("remote")).toBe("Remote");
    expect(workplaceLabel("hybrid")).toBe("Hybrid");
  });

  it("returns null for null or blank, so the chip is simply not rendered", () => {
    expect(workplaceLabel(null)).toBeNull();
    expect(workplaceLabel("")).toBeNull();
    expect(workplaceLabel("   ")).toBeNull();
  });

  it("passes an unrecognised value through rather than hiding it", () => {
    expect(workplaceLabel("flexible")).toBe("flexible");
  });
});

describe("hasActiveOpportunityFilters", () => {
  it("is false for the untouched default", () => {
    expect(hasActiveOpportunityFilters(NO_OPPORTUNITY_FILTERS)).toBe(false);
  });

  it("is true once a workplace value is selected", () => {
    expect(hasActiveOpportunityFilters({ workplace: ["remote"] })).toBe(true);
  });
});

describe("applyOpportunityFilters", () => {
  it("returns every row when nothing is selected", () => {
    const rows = [opportunity("Remote"), opportunity(null), opportunity("Hybrid")];
    expect(applyOpportunityFilters(rows, NO_OPPORTUNITY_FILTERS)).toHaveLength(3);
  });

  it("keeps rows with no fit analysis — a filter must not hide unanalysed jobs", () => {
    const unanalysed = opportunity("Remote");
    expect(unanalysed.fitAnalysis).toBeNull();

    const result = applyOpportunityFilters([unanalysed], { workplace: ["remote"] });

    expect(result).toHaveLength(1);
  });

  it("narrows to matching rows only", () => {
    const rows = [opportunity("Remote"), opportunity(null), opportunity("Hybrid")];

    const result = applyOpportunityFilters(rows, { workplace: ["remote"] });

    expect(result).toHaveLength(1);
    expect(result[0].remoteType).toBe("Remote");
  });

  it("returns an empty list when nothing matches, without throwing", () => {
    expect(applyOpportunityFilters([opportunity(null)], { workplace: ["remote"] })).toEqual([]);
  });
});
