import { describe, expect, it } from "vitest";
import {
  assessAssociatedQualifiers,
  assessQualifiers,
  compareByAssociatedQualifierPreference,
  compareByQualifierPreference,
  preferredQualifiers,
  qualifierPreferenceLabel,
} from "./candidateQualifiers.js";
import { matchesAnyTargetRole } from "./roleTaxonomy.js";

/**
 * The approved matching contract: canonical role relevance is REQUIRED, and a
 * raw phrase's extra words are PREFERENCES that rank otherwise relevant jobs.
 * These are pure-function tests; the feed's SQL ordering and the eligibility
 * explanations that consume them are separate.
 */

describe("preferredQualifiers", () => {
  it("keeps the words the canonical role does not already say", () => {
    expect(preferredQualifiers("Azure Data Engineer", "Data Engineer")).toEqual(["azure"]);
  });

  it("returns nothing when there is no recorded phrase, or it adds nothing", () => {
    expect(preferredQualifiers(null, "Data Engineer")).toEqual([]);
    expect(preferredQualifiers("Data Engineer", "Data Engineer")).toEqual([]);
    expect(preferredQualifiers("  ", "Data Engineer")).toEqual([]);
  });

  it("drops seniority and filler words that qualify nothing", () => {
    expect(preferredQualifiers("Senior Azure Data Engineer", "Data Engineer")).toEqual(["azure"]);
  });

  it("preserves the candidate's order and removes duplicates", () => {
    expect(preferredQualifiers("Azure Azure Snowflake Data Engineer", "Data Engineer")).toEqual([
      "azure",
      "snowflake",
    ]);
  });
});

describe("assessQualifiers", () => {
  const evidence = {
    title: "Data Engineer",
    description: "Build pipelines on Azure with Snowflake.",
    skills: ["sql", "python"],
  };

  it("matches from the description and from structured skills, not only the title", () => {
    expect(assessQualifiers(["azure"], evidence)).toEqual({ matched: ["azure"], noEvidence: [] });
    expect(assessQualifiers(["snowflake"], evidence).matched).toEqual(["snowflake"]);
    expect(assessQualifiers(["sql"], evidence).matched).toEqual(["sql"]);
    expect(assessQualifiers(["python"], evidence).matched).toEqual(["python"]);
  });

  it("reports absence as NO EVIDENCE, never as a mismatch", () => {
    const assessment = assessQualifiers(["azure"], { title: "Data Engineer" });

    expect(assessment.matched).toEqual([]);
    expect(assessment.noEvidence).toEqual(["azure"]);
    // The shape has no "missing"/"failed" field on purpose: a posting that never
    // mentions Azure has not contradicted the preference.
    expect(Object.keys(assessment)).toEqual(["matched", "noEvidence"]);
  });

  it("treats a missing description as unknown, not as proof either way", () => {
    expect(assessQualifiers(["azure"], { title: "Data Engineer", description: null }).noEvidence).toEqual([
      "azure",
    ]);
  });
});

describe("ranking without exclusion", () => {
  const azure = { title: "Data Engineer", description: "Azure data platform." };
  const generic = { title: "Data Engineer", description: "Build ETL pipelines." };
  const unrelatedAzure = { title: "Nurse", description: "Azure Street clinic." };

  it("ranks a relevant Azure posting above an otherwise comparable generic one", () => {
    const ordered = [generic, azure].sort((a, b) =>
      compareByQualifierPreference({ evidence: a }, { evidence: b }, ["azure"]),
    );

    expect(ordered[0]).toBe(azure);
  });

  it("does NOT drop the generic relevant posting", () => {
    const ordered = [generic, azure].sort((a, b) =>
      compareByQualifierPreference({ evidence: a }, { evidence: b }, ["azure"]),
    );

    // Both survive: the contract is a preference, and a Data Engineer job that
    // does not mention Azure is still a Data Engineer job.
    expect(ordered).toHaveLength(2);
    expect(ordered).toContain(generic);
  });

  it("does not let an unrelated Azure posting into the results at all", () => {
    const relevant = [azure, generic, unrelatedAzure].filter((posting) =>
      matchesAnyTargetRole(posting.title, ["Data Engineer"]),
    );

    // Relevance is the caller's requirement and this module never relaxes it, so
    // mentioning Azure cannot promote an unrelated occupation.
    expect(relevant).not.toContain(unrelatedAzure);
  });

  it("is stable when there is no preference recorded", () => {
    expect(compareByQualifierPreference({ evidence: azure }, { evidence: generic }, [])).toBe(0);
  });
});

describe("qualifierPreferenceLabel", () => {
  it("says preferred, never only", () => {
    expect(qualifierPreferenceLabel(["azure"])).toBe("Azure preferred");
    expect(qualifierPreferenceLabel(["azure", "snowflake"])).toBe("Azure Snowflake preferred");
    expect(qualifierPreferenceLabel([])).toBeNull();
    expect(qualifierPreferenceLabel(["azure"])).not.toContain("only");
  });
});

describe("assessAssociatedQualifiers — the authoritative associated ranking rule", () => {
  const evidence = {
    title: "Data Engineer",
    description: "Build pipelines on Azure with Snowflake.",
  };

  it("counts a qualifier only for the ROLE this vacancy matches", () => {
    const associated = [
      { roleName: "Data Engineer", qualifier: "azure" },
      { roleName: "Teacher", qualifier: "azure" },
    ];

    expect(assessAssociatedQualifiers(associated, evidence, new Set(["Teacher"])).matched).toEqual([
      "azure",
    ]);
    // The qualifier belongs to Teacher, which this vacancy matches, so it counts
    // even though the phrase was phrased against Data Engineer too. The
    // DISTINCT rule is what keeps it from counting twice.
    expect(assessAssociatedQualifiers(associated, evidence, new Set(["Data Engineer", "Teacher"])).matched).toEqual([
      "azure",
    ]);
  });

  it("ignores a qualifier from a role the vacancy does NOT match", () => {
    const associated = [{ roleName: "Teacher", qualifier: "azure" }];

    expect(assessAssociatedQualifiers(associated, evidence, new Set(["Data Engineer"]))).toEqual({
      matched: [],
      noEvidence: [],
    });
  });

  it("keeps a generic relevant posting with zero matched qualifiers", () => {
    const generic = { title: "Data Engineer", description: "Build pipelines." };
    const associated = [{ roleName: "Data Engineer", qualifier: "azure" }];

    // Absence of evidence is reported, never a hard exclusion — and the two
    // postings still order with the Azure one first.
    expect(assessAssociatedQualifiers(associated, generic, new Set(["Data Engineer"])).matched).toEqual([]);
    expect(compareByAssociatedQualifierPreference(
      { evidence, matchedRoles: new Set(["Data Engineer"]) },
      { evidence: generic, matchedRoles: new Set(["Data Engineer"]) },
      associated,
    )).toBeLessThan(0);
  });

  it("is stable with no preference recorded", () => {
    expect(compareByAssociatedQualifierPreference(
      { evidence, matchedRoles: new Set(["Data Engineer"]) },
      { evidence, matchedRoles: new Set(["Data Engineer"]) },
      [],
    )).toBe(0);
  });
});
