import { describe, expect, it } from "vitest";
import { AGENT_QUICK_PROMPTS } from "../../../shared/agent";
import { pageForPath, suggestCopilotPrompts, type CopilotPage } from "./copilotPrompts";

const ALL_PAGES: CopilotPage[] = ["home", "resumes", "opportunities", "applications", "responses", "other"];
const NO_ROLES = { targetRoleCount: 0, extractedFactCount: 0 };
const ROLES_ONLY = { targetRoleCount: 3, extractedFactCount: 0 };
const READY = { targetRoleCount: 3, extractedFactCount: 12 };

describe("pageForPath", () => {
  it("maps the candidate routes", () => {
    expect(pageForPath("/")).toBe("home");
    expect(pageForPath("")).toBe("home");
    expect(pageForPath("/resumes")).toBe("resumes");
    expect(pageForPath("/opportunities")).toBe("opportunities");
    expect(pageForPath("/applications")).toBe("applications");
    expect(pageForPath("/responses")).toBe("responses");
  });

  it("falls back to other rather than guessing", () => {
    expect(pageForPath("/security")).toBe("other");
    expect(pageForPath("/billing")).toBe("other");
    expect(pageForPath("/target-roles")).toBe("other");
  });
});

describe("suggestCopilotPrompts — the Home setup ladder", () => {
  it("asks for target roles when there are none", () => {
    const suggestions = suggestCopilotPrompts("home", NO_ROLES);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].prompt).toBeNull();
    expect(suggestions[0].prerequisite?.href).toBe("/target-roles");
  });

  it("asks for a resume once roles exist but nothing has been extracted", () => {
    const suggestions = suggestCopilotPrompts("home", ROLES_ONLY);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].prompt).toBeNull();
    expect(suggestions[0].prerequisite?.href).toBe("/resumes");
  });

  it("offers normal job-search prompts once both exist", () => {
    const suggestions = suggestCopilotPrompts("home", READY);

    expect(suggestions.every((entry) => entry.prompt !== null)).toBe(true);
    expect(suggestions.map((entry) => entry.label)).toContain("Show my top-matching jobs today");
    expect(suggestions[0].prompt).toBe(AGENT_QUICK_PROMPTS[0]);
  });
});

describe("suggestCopilotPrompts — resume-dependent prompts", () => {
  it("never offers resume analysis as usable without extracted facts", () => {
    for (const page of ALL_PAGES) {
      for (const signals of [NO_ROLES, ROLES_ONLY]) {
        const analysis = suggestCopilotPrompts(page, signals).find((entry) =>
          entry.label.startsWith("Analyze my resume gaps"),
        );

        if (analysis) {
          // Present, but only ever as a prerequisite.
          expect(analysis.prompt).toBeNull();
          expect(analysis.prerequisite?.href).toBe("/resumes");
        }
      }
    }
  });

  it("offers resume analysis as usable once facts exist", () => {
    const suggestions = suggestCopilotPrompts("resumes", READY);
    const analysis = suggestions.find((entry) => entry.label.startsWith("Analyze my resume gaps"));

    expect(analysis?.prompt).toBe(AGENT_QUICK_PROMPTS[1]);
  });

  it("links the prerequisite to the resumes page", () => {
    const suggestions = suggestCopilotPrompts("resumes", ROLES_ONLY);

    expect(suggestions[0].prompt).toBeNull();
    expect(suggestions[0].prerequisite?.href).toBe("/resumes");
    expect(suggestions[0].prerequisite?.message).toContain("extracted");
  });
});

describe("suggestCopilotPrompts — unknown account data", () => {
  /**
   * Null is "could not read", not "there is none". Claiming a prerequisite would
   * tell a candidate with a perfectly good resume to go and upload one.
   */
  it("claims no prerequisite it cannot prove", () => {
    for (const page of ALL_PAGES) {
      const suggestions = suggestCopilotPrompts(page, null);

      expect(suggestions.every((entry) => entry.prerequisite === undefined)).toBe(true);
    }
  });

  it("omits the resume-dependent suggestion entirely rather than guessing", () => {
    const suggestions = suggestCopilotPrompts("home", null);

    expect(suggestions.some((entry) => entry.label.startsWith("Analyze my resume gaps"))).toBe(false);
    expect(suggestions.length).toBeGreaterThan(0);
  });
});

describe("suggestCopilotPrompts — page-level only", () => {
  it("asks about the search on opportunities, never about a specific job", () => {
    const suggestions = suggestCopilotPrompts("opportunities", READY);
    const text = suggestions.map((entry) => entry.label).join(" | ").toLowerCase();

    // No job is selected anywhere in the app, so a job-specific question would
    // refer to nothing.
    expect(text).not.toContain("this job");
  });

  it("asks for roles before talking about matches", () => {
    const suggestions = suggestCopilotPrompts("opportunities", NO_ROLES);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].prompt).toBeNull();
  });

  it("gates the follow-up draft on extracted facts", () => {
    const without = suggestCopilotPrompts("applications", ROLES_ONLY);
    const followUp = without.find((entry) => entry.label.startsWith("Draft a follow-up"));

    expect(followUp?.prompt).toBeNull();
    expect(followUp?.prerequisite?.href).toBe("/resumes");

    const withFacts = suggestCopilotPrompts("applications", READY);
    expect(withFacts.find((entry) => entry.label.startsWith("Draft a follow-up"))?.prompt).toBe(
      AGENT_QUICK_PROMPTS[2],
    );
  });

  it("offers replies prompts on responses with no prerequisites", () => {
    const suggestions = suggestCopilotPrompts("responses", NO_ROLES);

    expect(suggestions).toHaveLength(3);
    expect(suggestions.every((entry) => entry.prompt !== null)).toBe(true);
  });
});

describe("suggestCopilotPrompts — invariants", () => {
  it("always returns between one and three suggestions", () => {
    for (const page of ALL_PAGES) {
      for (const signals of [null, NO_ROLES, ROLES_ONLY, READY]) {
        const suggestions = suggestCopilotPrompts(page, signals);

        expect(suggestions.length).toBeGreaterThan(0);
        expect(suggestions.length).toBeLessThanOrEqual(3);
      }
    }
  });

  /**
   * Every pill is either a question with something behind it, or an honest
   * prerequisite. There is no third state, and no duplicate labels to confuse a
   * candidate about which one they pressed.
   */
  it("gives every suggestion either a prompt or a prerequisite, never neither and never both", () => {
    for (const page of ALL_PAGES) {
      for (const signals of [null, NO_ROLES, ROLES_ONLY, READY]) {
        const suggestions = suggestCopilotPrompts(page, signals);
        const labels = suggestions.map((entry) => entry.label);

        expect(new Set(labels).size).toBe(labels.length);

        for (const entry of suggestions) {
          if (entry.prompt === null) {
            expect(entry.prerequisite).toBeDefined();
            expect(entry.prerequisite?.href.startsWith("/")).toBe(true);
          } else {
            expect(entry.prerequisite).toBeUndefined();
            expect(entry.prompt.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
