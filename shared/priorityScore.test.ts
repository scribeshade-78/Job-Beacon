import { describe, expect, it } from "vitest";
import {
  computePriorityScore,
  FACTOR_WEIGHTS,
  NEUTRAL_FACTOR_VALUE,
  PRIORITY_SCORE_VERSION,
} from "./priorityScore.js";

describe("FACTOR_WEIGHTS", () => {
  it("sum to exactly 1.00", () => {
    const sum = (Object.values(FACTOR_WEIGHTS) as number[]).reduce((a, b) => a + b, 0);
    expect(Math.round(sum * 1000) / 1000).toBe(1);
  });
});

describe("computePriorityScore", () => {
  it("null input (no fit analysis) => all-null score, pending state", () => {
    expect(computePriorityScore(null)).toEqual({
      score: null,
      uncappedScore: null,
      capped: false,
      components: null,
      version: PRIORITY_SCORE_VERSION,
    });
  });

  it("both real factors at neutral 50 => 50", () => {
    const r = computePriorityScore({ technicalFitScore: 50, practicalEligibilityScore: 50, eligibilityCapped: false });
    expect(r.score).toBe(50);
    expect(r.uncappedScore).toBe(50);
    expect(r.capped).toBe(false);
  });

  it("technical fit 100 + practical eligibility 100, rest neutral => 0.2*100 + 0.2*100 + 0.6*50 = 70", () => {
    const r = computePriorityScore({ technicalFitScore: 100, practicalEligibilityScore: 100, eligibilityCapped: false });
    expect(r.score).toBe(70);
  });

  it("technical fit 0 + practical eligibility 0 => 0.6*50 = 30", () => {
    const r = computePriorityScore({ technicalFitScore: 0, practicalEligibilityScore: 0, eligibilityCapped: false });
    expect(r.score).toBe(30);
  });

  it("worked example: techFit 80, practicalElig 100 => 66", () => {
    const r = computePriorityScore({ technicalFitScore: 80, practicalEligibilityScore: 100, eligibilityCapped: false });
    expect(r.score).toBe(66);
  });

  it("eligibilityCapped forces score to 0 but preserves the uncapped score and components", () => {
    const r = computePriorityScore({ technicalFitScore: 90, practicalEligibilityScore: 0, eligibilityCapped: true });
    expect(r.score).toBe(0);
    expect(r.capped).toBe(true);
    expect(r.uncappedScore).toBeGreaterThan(0);
    expect(r.components?.technical_fit.value).toBe(90);
  });

  it("null technical fit (JD unavailable) is treated as neutral 50", () => {
    const withNull = computePriorityScore({ technicalFitScore: null, practicalEligibilityScore: 100, eligibilityCapped: false });
    const with50 = computePriorityScore({ technicalFitScore: 50, practicalEligibilityScore: 100, eligibilityCapped: false });
    expect(withNull.score).toBe(with50.score);
    expect(withNull.components?.technical_fit.source).toBe("neutral");
    expect(withNull.components?.technical_fit.value).toBe(NEUTRAL_FACTOR_VALUE);
  });

  it("null practical eligibility (INSUFFICIENT_DATA) is treated as neutral 50", () => {
    const r = computePriorityScore({ technicalFitScore: 60, practicalEligibilityScore: null, eligibilityCapped: false });
    expect(r.components?.practical_eligibility.source).toBe("neutral");
    expect(r.components?.practical_eligibility.value).toBe(NEUTRAL_FACTOR_VALUE);
  });

  it("marks real fit factors with source 'fit'", () => {
    const r = computePriorityScore({ technicalFitScore: 42, practicalEligibilityScore: 77, eligibilityCapped: false });
    expect(r.components?.technical_fit).toEqual({ weight: 0.2, value: 42, source: "fit" });
    expect(r.components?.practical_eligibility).toEqual({ weight: 0.2, value: 77, source: "fit" });
    expect(r.components?.response_stage.source).toBe("neutral");
  });

  it("clamps an out-of-range factor value into 0-100", () => {
    const r = computePriorityScore({ technicalFitScore: 150, practicalEligibilityScore: -20, eligibilityCapped: false });
    expect(r.components?.technical_fit.value).toBe(100);
    expect(r.components?.practical_eligibility.value).toBe(0);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});
