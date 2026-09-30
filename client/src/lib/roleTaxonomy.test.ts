import { describe, expect, it } from "vitest";
import { ROLE_CATEGORIES, ROLE_TAXONOMY, searchRoles } from "./roleTaxonomy";

describe("ROLE_TAXONOMY", () => {
  it("has unique ids", () => {
    const ids = ROLE_TAXONOMY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only uses declared categories", () => {
    for (const entry of ROLE_TAXONOMY) {
      expect(ROLE_CATEGORIES).toContain(entry.category);
    }
  });
});

describe("searchRoles", () => {
  it("matches by title substring, case-insensitively", () => {
    const results = searchRoles("SOFTWARE engineer");
    expect(results.map((entry) => entry.id)).toContain("software-engineer");
  });

  it("matches by alias substring", () => {
    const results = searchRoles("sdr");
    expect(results.map((entry) => entry.id)).toContain("sales-development-representative");
  });

  it("returns no results for an empty or whitespace-only query", () => {
    expect(searchRoles("")).toEqual([]);
    expect(searchRoles("   ")).toEqual([]);
  });

  it("ranks an exact title match first", () => {
    expect(searchRoles("Data Engineer")[0].id).toBe("data-engineer");
  });

  it("matches a multi-token query even when one token is unknown", () => {
    // "Azure" appears in no title, alias or skill, so the whole-string rule this
    // replaced returned nothing and the panel fell back to its defaults. The
    // known tokens still have to surface what they describe.
    const results = searchRoles("Azure Data Engineer");
    expect(results[0].id).toBe("data-engineer");
    expect(results.map((entry) => entry.id)).toContain("data-analyst");
  });

  it("returns every title carrying a single query token", () => {
    const ids = searchRoles("Data").map((entry) => entry.id);
    expect(ids).toContain("data-analyst");
    expect(ids).toContain("data-scientist");
    expect(ids).toContain("data-engineer");
  });

  it("matches an alias as a whole string", () => {
    expect(searchRoles("sdr")[0].id).toBe("sales-development-representative");
  });

  it("tolerates a typo in each token", () => {
    expect(searchRoles("Dat Enginer")[0].id).toBe("data-engineer");
  });

  it("matches a skill, the taxonomy's existing related-term surface", () => {
    expect(searchRoles("spark").map((entry) => entry.id)).toContain("data-engineer");
  });

  it("keeps an exact match above a partial one", () => {
    const results = searchRoles("Data Analyst");
    expect(results[0].id).toBe("data-analyst");
    expect(results.map((entry) => entry.id)).toContain("data-engineer");
  });

  it("returns no results when nothing matches", () => {
    expect(searchRoles("astronaut")).toEqual([]);
  });
});
