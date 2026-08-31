import { describe, expect, it, vi } from "vitest";
import {
  analyzeTechnicalFit,
  isValidRawFitAnalysis,
  MalformedFitAnalysisError,
  FIT_DIMENSIONS,
  type RawFitAnalysis,
} from "./fitPrompt.js";

function wellFormed(): RawFitAnalysis {
  const components = Object.fromEntries(
    FIT_DIMENSIONS.map((d) => [d, { score: 70, rationale: `ok ${d}` }]),
  ) as RawFitAnalysis["components"];
  return {
    overall: 72,
    components,
    missing_evidence: ["Kubernetes"],
    top_reasons: ["Strong backend match"],
    risks: ["Role may require US work authorisation"],
  };
}

describe("isValidRawFitAnalysis", () => {
  it("accepts a well-formed object", () => {
    expect(isValidRawFitAnalysis(wellFormed())).toBe(true);
  });

  it("rejects a score above 100", () => {
    expect(isValidRawFitAnalysis({ ...wellFormed(), overall: 140 })).toBe(false);
  });

  it("rejects a non-array missing_evidence", () => {
    expect(isValidRawFitAnalysis({ ...wellFormed(), missing_evidence: "Kubernetes" })).toBe(false);
  });

  it("rejects a missing component dimension", () => {
    const bad = wellFormed();
    delete (bad.components as Record<string, unknown>).domain;
    expect(isValidRawFitAnalysis(bad)).toBe(false);
  });

  it("rejects a component with a non-numeric score", () => {
    const bad = wellFormed();
    (bad.components as Record<string, unknown>).seniority = { score: "high", rationale: "x" };
    expect(isValidRawFitAnalysis(bad)).toBe(false);
  });

  it("rejects extra top-level keys via component count mismatch", () => {
    const bad = wellFormed();
    (bad.components as Record<string, unknown>).extra = { score: 1, rationale: "x" };
    expect(isValidRawFitAnalysis(bad)).toBe(false);
  });
});

describe("analyzeTechnicalFit", () => {
  function fakeClient(content: string) {
    return {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } },
    } as never;
  }

  const input = {
    jdText: "We need a senior platform engineer with AWS and Go.",
    sectionHeadings: ["Responsibilities"],
    factLines: ["current_title: Platform Engineer", "skill: Go"],
    roleTitle: "Senior Platform Engineer",
  };

  it("returns the parsed analysis on well-formed output", async () => {
    const client = fakeClient(JSON.stringify(wellFormed()));
    const result = await analyzeTechnicalFit(client, input);
    expect(result.overall).toBe(72);
    expect(result.missing_evidence).toEqual(["Kubernetes"]);
  });

  it("throws MalformedFitAnalysisError on non-JSON content", async () => {
    await expect(analyzeTechnicalFit(fakeClient("not json"), input)).rejects.toBeInstanceOf(MalformedFitAnalysisError);
  });

  it("throws MalformedFitAnalysisError when the shape is wrong", async () => {
    await expect(
      analyzeTechnicalFit(fakeClient(JSON.stringify({ ...wellFormed(), overall: -5 })), input),
    ).rejects.toBeInstanceOf(MalformedFitAnalysisError);
  });
});
