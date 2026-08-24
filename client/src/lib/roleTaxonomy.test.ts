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

  it("returns no results when nothing matches", () => {
    expect(searchRoles("astronaut")).toEqual([]);
  });
});
