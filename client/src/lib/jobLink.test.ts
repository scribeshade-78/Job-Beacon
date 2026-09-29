import { describe, expect, it } from "vitest";
import {
  APPLY_ON_EMPLOYER_SITE_LABEL,
  OPEN_ORIGINAL_POSTING_LABEL,
  describeJobLink,
  describeJobLinkAriaLabel,
} from "./jobLink";

describe("describeJobLink", () => {
  /**
   * THE BUG THIS REPLACES. Every production vacancy is an aggregator listing, so
   * an "Apply" label would promise an application the click does not make.
   */
  it("labels an aggregator listing as an original posting, never as applying", () => {
    for (const sourceCode of ["remotive", "themuse", "arbeitnow", "jooble", "serpapi", "usajobs", "adzuna"]) {
      const described = describeJobLink(sourceCode);

      expect(described.kind).toBe("source_listing");
      expect(described.label).toBe(OPEN_ORIGINAL_POSTING_LABEL);
      expect(described.label).not.toContain("Apply");
    }
  });

  it("labels an employer-hosted ATS posting as applying on the employer site", () => {
    for (const sourceCode of ["greenhouse", "lever"]) {
      const described = describeJobLink(sourceCode);

      expect(described.kind).toBe("employer_application");
      expect(described.label).toBe(APPLY_ON_EMPLOYER_SITE_LABEL);
    }
  });

  /**
   * The label states where the click goes. "Apply on employer site" is only
   * sayable when the employer hosts the form; the arrow makes the navigation
   * explicit in both cases.
   */
  it("always states the destination and marks it as leaving the app", () => {
    for (const sourceCode of ["greenhouse", "remotive", "unheard_of"]) {
      expect(describeJobLink(sourceCode).label).toContain("↗");
    }
  });

  it("treats an unknown source as a plain listing rather than an employer form", () => {
    // Fail safe: an unrecognised source must not earn the stronger label.
    expect(describeJobLink("some_new_aggregator").kind).toBe("source_listing");
  });

  it("does not treat the development fixture as an employer application page", () => {
    expect(describeJobLink("local_fixture").kind).toBe("source_listing");
  });
});

describe("describeJobLinkAriaLabel", () => {
  /**
   * The visible label is identical on every row, so it cannot be the accessible
   * name: a screen-reader user would hear the same link repeated down the list.
   */
  it("names the job, so repeated links are distinguishable", () => {
    const label = describeJobLinkAriaLabel("remotive", "Staff Engineer");

    expect(label).toContain("Staff Engineer");
    expect(label).toContain(OPEN_ORIGINAL_POSTING_LABEL);
  });

  it("states that a new tab opens, because the arrow glyph announces as nothing", () => {
    expect(describeJobLinkAriaLabel("greenhouse", "Data Engineer")).toContain("opens in a new tab");
  });

  it("uses the same verb the visible label uses", () => {
    expect(describeJobLinkAriaLabel("greenhouse", "Data Engineer")).toContain("Apply on employer site");
    expect(describeJobLinkAriaLabel("jooble", "Data Engineer")).toContain("Open original job posting");
  });

  it("degrades to a generic noun for a blank title rather than trailing punctuation", () => {
    expect(describeJobLinkAriaLabel("remotive", "   ")).toContain("this job");
  });
});
