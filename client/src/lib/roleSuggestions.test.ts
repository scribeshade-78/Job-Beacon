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

    // NO PERSONALISED TIER MAY APPEAR - an unconfirmed fact is not a signal. What the
    // candidate gets instead is the broad default list, which claims nothing about
    // them, so the guarantee is unchanged and only its shape is.
    // THE GUARANTEE IS THAT THE FACT CHANGES NOTHING, so the output is byte-identical
    // to the no-facts baseline. Asserting "Software Engineer is absent" was wrong and
    // failed correctly: that title IS in the broad default list, as the first
    // Engineering entry - being present is not evidence the fact was used.
    expect(suggestions.every((suggestion) => suggestion.tier === "default")).toBe(true);
    expect(suggestions).toEqual(suggestRoles([]));
  });

  it("ignores rejected facts", () => {
    const suggestions = suggestRoles([
      fact({ factType: "current_title", factValue: "Software Engineer", confirmationStatus: "rejected" }),
    ]);

    // THE GUARANTEE IS THAT THE FACT CHANGES NOTHING, so the output is byte-identical
    // to the no-facts baseline. Asserting "Software Engineer is absent" was wrong and
    // failed correctly: that title IS in the broad default list, as the first
    // Engineering entry - being present is not evidence the fact was used.
    expect(suggestions.every((suggestion) => suggestion.tier === "default")).toBe(true);
    expect(suggestions).toEqual(suggestRoles([]));
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

  it("returns no PERSONALISED tier for no confirmed facts", () => {
    // It used to return nothing at all, which left a new candidate on a blank page.
    // The fallback is deliberately a different tier so it can never be mistaken for
    // a match derived from the profile.
    const suggestions = suggestRoles([]);

    expect(suggestions.some((suggestion) => ["primary", "strong", "related"].includes(suggestion.tier))).toBe(false);
  });
});

describe("suggestRoles - the broad fallback for a candidate with nothing to personalise from", () => {
  it("returns clickable suggestions instead of nothing when there are no confirmed facts", () => {
    // The state a brand-new candidate is in before they upload a resume. This used
    // to return [] and the panel rendered a blank page with a search box.
    const suggestions = suggestRoles([]);

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((suggestion) => suggestion.tier === "default")).toBe(true);
  });

  it("is DIVERSE - one entry per category, never several from the same one", () => {
    // "Diverse" has to be checkable. The catalog is grouped by category, so the
    // naive "first N entries" would return seven Engineering roles and nothing else.
    const categories = suggestRoles([]).map((suggestion) => suggestion.entry.category);

    expect(new Set(categories).size).toBe(categories.length);
    expect(new Set(categories).size).toBeGreaterThan(3);
  });

  it("stays out of the way when there is something personal to say", () => {
    const suggestions = suggestRoles([
      fact({ factType: "current_title", factValue: "Frontend Engineer" }),
      fact({ factType: "skill", factValue: "react" }),
      fact({ factType: "skill", factValue: "typescript" }),
    ]);

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((suggestion) => suggestion.tier === "default")).toBe(false);
  });
});
