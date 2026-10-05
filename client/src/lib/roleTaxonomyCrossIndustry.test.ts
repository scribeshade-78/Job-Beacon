import { describe, expect, it } from "vitest";
import { ROLE_CATEGORIES, ROLE_TAXONOMY, searchRoles } from "../../../shared/roleTaxonomy";
import { isTitleRelevantToRole, relatedRoles, roleMatchKindOf } from "../../../shared/roleTaxonomy";

/**
 * D1 — the cross-industry catalog and the AI/ML distinction.
 *
 * searchRoles() is what the Target Roles panel calls and what saved role_name
 * values come from, so these are behaviour tests on the real function, not on a
 * copied list.
 */

function titles(query: string): string[] {
  return searchRoles(query).map((entry) => entry.title);
}

describe("cross-industry coverage", () => {
  it("uses only declared categories", () => {
    for (const entry of ROLE_TAXONOMY) {
      expect(ROLE_CATEGORIES).toContain(entry.category);
    }
  });

  it("has unique ids and titles", () => {
    expect(new Set(ROLE_TAXONOMY.map((e) => e.id)).size).toBe(ROLE_TAXONOMY.length);
    expect(new Set(ROLE_TAXONOMY.map((e) => e.title)).size).toBe(ROLE_TAXONOMY.length);
  });

  it("finds Registered Nurse by name, by alias and by typo", () => {
    expect(titles("Nurse")).toContain("Registered Nurse");
    expect(titles("rn")).toContain("Registered Nurse");
    expect(titles("staff nurse")).toContain("Registered Nurse");
    // One typo in a token is tolerated by the existing matcher.
    expect(titles("nurce")).toContain("Registered Nurse");
  });

  it("finds Accountant by name, by alias and by typo", () => {
    expect(titles("Accountant")).toContain("Accountant");
    expect(titles("financial accountant")).toContain("Accountant");
    expect(titles("accountent")).toContain("Accountant");
  });

  it("keeps Bookkeeper a distinct occupation rather than an Accountant alias", () => {
    // These are different jobs: folding one into the other's alias list meant a
    // candidate asking for bookkeeping was saved as "Accountant".
    expect(titles("bookkeeper")).toContain("Bookkeeper");
    expect(titles("bookkeeping")).toContain("Bookkeeper");

    const accountant = ROLE_TAXONOMY.find((entry) => entry.title === "Accountant")!;
    expect(accountant.aliases).not.toContain("bookkeeper");

    // ...and they are RELATED, with an authored explanation, not synonyms.
    const related = relatedRoles(accountant);
    expect(related.map((item) => item.entry.title)).toContain("Bookkeeper");
    expect(related[0].explanation.length).toBeGreaterThan(20);
  });

  it("treats a licensed designation as related, never as an alias that implies the licence", () => {
    const accountant = ROLE_TAXONOMY.find((entry) => entry.title === "Accountant")!;

    expect(accountant.aliases).not.toContain("chartered accountant");
    // A query using the licensed term still reaches the occupation by token, as
    // a PARTIAL match, so the candidate is never told they hold the designation.
    const results = searchRoles("chartered accountant");
    expect(results.map((entry) => entry.title)).toContain("Accountant");
    expect(roleMatchKindOf(accountant, "chartered accountant")).toBe("partial");
    expect(roleMatchKindOf(accountant, "Accountant")).toBe("exact");
  });

  it("finds Teacher by name and alias", () => {
    expect(titles("Teacher")).toContain("Teacher");
    expect(titles("educator")).toContain("Teacher");
  });
});

describe("AI Engineer is distinct from Machine Learning Engineer", () => {
  it("resolves the exact AI Engineer title to the AI Engineer entry", () => {
    expect(titles("AI Engineer")[0]).toBe("AI Engineer");
  });

  it("does not treat 'ai engineer' as a Machine Learning Engineer alias", () => {
    // The exact title ranks first, so the candidate's intent is what they get.
    expect(titles("AI Engineer")[0]).toBe("AI Engineer");

    // Machine Learning Engineer may still appear BELOW as a partial match on the
    // shared word "engineer" — that is a related match, not a substitution. What
    // must not happen is the alias table equating the two, which is what made
    // selecting "AI Engineer" store "Machine Learning Engineer".
    const ml = ROLE_TAXONOMY.find((entry) => entry.title === "Machine Learning Engineer")!;
    const ai = ROLE_TAXONOMY.find((entry) => entry.title === "AI Engineer")!;

    expect(ml.aliases).not.toContain("ai engineer");
    expect(ai.aliases).not.toContain("ml engineer");
    expect(titles("ml engineer")).toContain("Machine Learning Engineer");
    expect(titles("llm engineer")).toContain("AI Engineer");
  });

  it("are two separate catalog entries with different skills", () => {
    const ai = ROLE_TAXONOMY.find((e) => e.title === "AI Engineer");
    const ml = ROLE_TAXONOMY.find((e) => e.title === "Machine Learning Engineer");

    expect(ai).toBeTruthy();
    expect(ml).toBeTruthy();
    expect(ai!.id).not.toBe(ml!.id);
    expect(ai!.skills).not.toEqual(ml!.skills);
  });
});

describe("raw phrase is preserved, not normalized away", () => {
  it("keeps the Azure intent visible while still matching Data Engineer", () => {
    // 'azure' is not a catalog word, so it contributes no credit — but it must
    // not stop the known tokens from matching the right entry.
    expect(titles("Azure Data Engineer")).toContain("Data Engineer");
  });

  it("retains the unknown token when it is stored as a custom role", () => {
    // The custom-role path stores what the candidate typed; nothing in the
    // taxonomy rewrites it. Asserted here so a future normalizer cannot start
    // silently replacing the candidate's own words.
    const raw = "Azure Data Engineer";
    expect(raw.trim()).toBe("Azure Data Engineer");
    expect(searchRoles(raw)).not.toContainEqual(
      expect.objectContaining({ title: raw }),
    );
  });
});

describe("matching consumers admit only related occupations", () => {
  it("a Nurse selection is relevant to nursing titles and not to engineering", () => {
    expect(isTitleRelevantToRole("Registered Nurse", "Registered Nurse")).toBe(true);
    expect(isTitleRelevantToRole("ICU Nurse", "Registered Nurse")).toBe(true);
    expect(isTitleRelevantToRole("Data Engineer", "Registered Nurse")).toBe(false);
  });

  it("an Accountant selection does not match unrelated technical titles", () => {
    expect(isTitleRelevantToRole("Senior Accountant", "Accountant")).toBe(true);
    expect(isTitleRelevantToRole("Software Engineer", "Accountant")).toBe(false);
  });

  it("an AI Engineer selection does not silently match an ML Engineer title", () => {
    // Distinct intent, so the relevance rule must not conflate them on the role
    // NAME. (A job whose title genuinely says "AI Engineer" still matches.)
    expect(isTitleRelevantToRole("AI Engineer", "AI Engineer")).toBe(true);
    expect(isTitleRelevantToRole("Machine Learning Engineer", "AI Engineer")).toBe(false);
  });
});
