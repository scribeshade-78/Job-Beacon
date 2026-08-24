import { describe, expect, it } from "vitest";
import { suggestRoles } from "./roleSuggestions";
import type { ExtractedFact } from "./resumeExtraction";

let nextId = 0;

function fact(overrides: Partial<ExtractedFact>): ExtractedFact {
  nextId += 1;
  return {
    id: `fact-${nextId}`,
    sourceDocumentId: "resume-1",
    factType: "current_title",
    factValue: "",
    createdAt: "2026-08-24T00:00:00Z",
    confirmationStatus: "confirmed",
    correctedValue: null,
    ...overrides,
  };
}

describe("suggestRoles", () => {
  it("suggests a Primary match on a confirmed current_title substring", () => {
    const suggestions = suggestRoles([fact({ factType: "current_title", factValue: "Senior Software Engineer" })]);

    const primary = suggestions.filter((s) => s.tier === "primary");
    expect(primary.map((s) => s.entry.id)).toContain("software-engineer");
  });

  it("resolves the effective value via correctedValue over factValue", () => {
    const suggestions = suggestRoles([
      fact({ factType: "current_title", factValue: "Astronaut", correctedValue: "Product Manager" }),
    ]);

    expect(suggestions.some((s) => s.entry.id === "product-manager" && s.tier === "primary")).toBe(true);
    expect(suggestions.some((s) => s.entry.title === "Astronaut")).toBe(false);
  });

  it("ignores facts that are not confirmed", () => {
    const suggestions = suggestRoles([
      fact({ factType: "current_title", factValue: "Software Engineer", confirmationStatus: "pending" }),
    ]);

    expect(suggestions).toEqual([]);
  });

  it("ignores rejected facts", () => {
    const suggestions = suggestRoles([
      fact({ factType: "current_title", factValue: "Software Engineer", confirmationStatus: "rejected" }),
    ]);

    expect(suggestions).toEqual([]);
  });

  it("promotes a same-category entry to Strong with >=2 shared confirmed skills", () => {
    const facts = [
      fact({ factType: "current_title", factValue: "Software Engineer" }),
      fact({ factType: "skill", factValue: "React" }),
      fact({ factType: "skill", factValue: "TypeScript" }),
    ];

    const suggestions = suggestRoles(facts);
    const frontend = suggestions.find((s) => s.entry.id === "frontend-engineer");

    expect(frontend?.tier).toBe("strong");
  });

  it("classifies a same-category entry with exactly 1 shared skill as Related", () => {
    const facts = [
      fact({ factType: "current_title", factValue: "Software Engineer" }),
      fact({ factType: "skill", factValue: "Docker" }),
    ];

    const suggestions = suggestRoles(facts);
    const devops = suggestions.find((s) => s.entry.id === "devops-engineer");

    expect(devops?.tier).toBe("related");
  });

  it("classifies a different-category entry with >=2 shared skills as Related", () => {
    const facts = [
      fact({ factType: "current_title", factValue: "Software Engineer" }),
      fact({ factType: "skill", factValue: "SQL" }),
      fact({ factType: "skill", factValue: "Excel" }),
    ];

    const suggestions = suggestRoles(facts);
    const dataAnalyst = suggestions.find((s) => s.entry.id === "data-analyst");

    expect(dataAnalyst?.tier).toBe("related");
  });

  it("does not suggest a different-category entry for only 1 shared skill", () => {
    const facts = [
      fact({ factType: "current_title", factValue: "Software Engineer" }),
      fact({ factType: "skill", factValue: "SQL" }),
    ];

    const suggestions = suggestRoles(facts);
    expect(suggestions.some((s) => s.entry.id === "data-analyst")).toBe(false);
  });

  it("never lists the same entry twice, even if it would qualify for multiple tiers", () => {
    const facts = [
      fact({ factType: "current_title", factValue: "Software Engineer" }),
      fact({ factType: "skill", factValue: "javascript" }),
      fact({ factType: "skill", factValue: "python" }),
      fact({ factType: "skill", factValue: "java" }),
    ];

    const suggestions = suggestRoles(facts);
    const swe = suggestions.filter((s) => s.entry.id === "software-engineer");

    expect(swe).toHaveLength(1);
    expect(swe[0].tier).toBe("primary");
  });

  it("returns skill-only Related suggestions when no title is confirmed", () => {
    const facts = [
      fact({ factType: "skill", factValue: "SQL" }),
      fact({ factType: "skill", factValue: "Excel" }),
    ];

    const suggestions = suggestRoles(facts);
    expect(suggestions.some((s) => s.entry.id === "data-analyst" && s.tier === "related")).toBe(true);
  });

  it("returns no suggestions for no confirmed facts", () => {
    expect(suggestRoles([])).toEqual([]);
  });
});
