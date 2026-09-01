import { describe, expect, it } from "vitest";
import {
  computePriorityScore,
  daysUntil,
  FACTOR_WEIGHTS,
  finalizeWithFreshUrgency,
  isResponseCategory,
  nearestDeadlineDays,
  NEUTRAL_FACTOR_VALUE,
  PRIORITY_SCORE_VERSION,
  type PriorityScoreInput,
} from "./priorityScore.js";

/** Both fit factors held at neutral 50 => a 50 baseline; each new factor moves it from there. */
const BASE: PriorityScoreInput = {
  technicalFitScore: NEUTRAL_FACTOR_VALUE,
  practicalEligibilityScore: NEUTRAL_FACTOR_VALUE,
  eligibilityCapped: false,
};

describe("FACTOR_WEIGHTS", () => {
  it("sum to exactly 1.00", () => {
    const sum = (Object.values(FACTOR_WEIGHTS) as number[]).reduce((a, b) => a + b, 0);
    expect(Math.round(sum * 1000) / 1000).toBe(1);
  });
});

describe("PRIORITY_SCORE_VERSION", () => {
  it("is priority-v3 (2.3b server-computed + stored)", () => {
    expect(PRIORITY_SCORE_VERSION).toBe("priority-v3");
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

describe("computePriorityScore — 2.3a real signals", () => {
  it("leaves every new factor neutral when no signal is supplied (BASE => 50)", () => {
    const r = computePriorityScore(BASE);
    expect(r.score).toBe(50);
    for (const f of [
      "response_stage",
      "employment_arrangement",
      "compensation_quality",
      "company_credibility",
      "urgency",
      "user_preferences",
    ] as const) {
      expect(r.components?.[f].value).toBe(NEUTRAL_FACTOR_VALUE);
      expect(r.components?.[f].source).toBe("neutral");
    }
  });

  describe("response_stage (25%)", () => {
    const cases: Array<[PriorityScoreInput["responseCategory"], number]> = [
      ["rejection", 0],
      ["application_received", 45],
      ["other", 50],
      ["recruiter_followup", 60],
      ["action_required", 70],
      ["interview", 85],
      ["offer", 100],
    ];
    for (const [category, value] of cases) {
      it(`${category} => ${value}, source fit`, () => {
        const r = computePriorityScore({ ...BASE, responseCategory: category });
        expect(r.components?.response_stage).toEqual({ weight: 0.25, value, source: "fit" });
      });
    }

    it("an application with no classified reply => Submitted (40)", () => {
      const r = computePriorityScore({ ...BASE, hasApplication: true });
      expect(r.components?.response_stage).toEqual({ weight: 0.25, value: 40, source: "fit" });
    });

    it("a classification wins over the bare hasApplication fallback", () => {
      const r = computePriorityScore({ ...BASE, hasApplication: true, responseCategory: "interview" });
      expect(r.components?.response_stage.value).toBe(85);
    });

    it("offer pushes the composite up by 0.25*(100-50)", () => {
      const r = computePriorityScore({ ...BASE, responseCategory: "offer" });
      expect(r.score).toBe(63); // 50 + 12.5 = 62.5 -> 63
    });
  });

  describe("employment_arrangement (10%)", () => {
    it.each([
      ["remote", 100],
      ["hybrid", 70],
      ["on_site", 40],
    ] as const)("%s => %i", (remoteType, value) => {
      const r = computePriorityScore({ ...BASE, remoteType });
      expect(r.components?.employment_arrangement).toEqual({ weight: 0.1, value, source: "fit" });
    });

    it("null remote type stays neutral", () => {
      const r = computePriorityScore({ ...BASE, remoteType: null });
      expect(r.components?.employment_arrangement.source).toBe("neutral");
    });
  });

  describe("compensation_quality (10%)", () => {
    it("employer-disclosed range => 90", () => {
      const r = computePriorityScore({ ...BASE, salary: { min: 60000, max: 80000, source: "employer_disclosed" } });
      expect(r.components?.compensation_quality).toEqual({ weight: 0.1, value: 90, source: "fit" });
    });

    it("employer-disclosed single figure => 70", () => {
      const r = computePriorityScore({ ...BASE, salary: { min: 60000, max: null, source: "employer_disclosed" } });
      expect(r.components?.compensation_quality.value).toBe(70);
    });

    it("employer-disclosed min === max => 70 (not a range)", () => {
      const r = computePriorityScore({ ...BASE, salary: { min: 60000, max: 60000, source: "employer_disclosed" } });
      expect(r.components?.compensation_quality.value).toBe(70);
    });

    it("estimated figure => 50 but marked real", () => {
      const r = computePriorityScore({ ...BASE, salary: { min: 60000, max: 80000, source: "estimated" } });
      expect(r.components?.compensation_quality).toEqual({ weight: 0.1, value: 50, source: "fit" });
    });

    it("no salary numbers => neutral (absence is not a negative signal)", () => {
      const r = computePriorityScore({ ...BASE, salary: { min: null, max: null, source: null } });
      expect(r.components?.compensation_quality.source).toBe("neutral");
    });
  });

  describe("urgency (5%)", () => {
    it.each([
      [0, 100],
      [3, 100],
      [4, 85],
      [7, 85],
      [14, 70],
      [30, 55],
      [31, 45],
      [365, 45],
    ])("%i days => %i", (deadlineDays, value) => {
      const r = computePriorityScore({ ...BASE, deadlineDays });
      expect(r.components?.urgency).toEqual({ weight: 0.05, value, source: "fit" });
    });

    it("a past deadline (negative) is ignored", () => {
      const r = computePriorityScore({ ...BASE, deadlineDays: -2 });
      expect(r.components?.urgency.source).toBe("neutral");
    });

    it("null deadline is neutral", () => {
      const r = computePriorityScore({ ...BASE, deadlineDays: null });
      expect(r.components?.urgency.source).toBe("neutral");
    });
  });

  describe("user_preferences (5%)", () => {
    it("role match => 100", () => {
      const r = computePriorityScore({ ...BASE, roleMatch: true });
      expect(r.components?.user_preferences).toEqual({ weight: 0.05, value: 100, source: "fit" });
    });

    it("no role match => 50 but real", () => {
      const r = computePriorityScore({ ...BASE, roleMatch: false });
      expect(r.components?.user_preferences).toEqual({ weight: 0.05, value: 50, source: "fit" });
    });

    it("no roles selected (null) => neutral", () => {
      const r = computePriorityScore({ ...BASE, roleMatch: null });
      expect(r.components?.user_preferences.source).toBe("neutral");
    });
  });

  describe("company_credibility (5%)", () => {
    it("stays neutral when no trust score is supplied", () => {
      const r = computePriorityScore({ ...BASE, responseCategory: "offer", remoteType: "remote", roleMatch: true });
      expect(r.components?.company_credibility).toEqual({ weight: 0.05, value: NEUTRAL_FACTOR_VALUE, source: "neutral" });
    });

    it("uses vacancy_trust_scores.score directly (already 0-100)", () => {
      const r = computePriorityScore({ ...BASE, companyCredibility: 87 });
      expect(r.components?.company_credibility).toEqual({ weight: 0.05, value: 87, source: "fit" });
    });

    it("a zero trust score is a real signal, not an absent one", () => {
      const r = computePriorityScore({ ...BASE, companyCredibility: 0 });
      expect(r.components?.company_credibility).toEqual({ weight: 0.05, value: 0, source: "fit" });
      expect(r.score).toBe(48); // 50 - 0.05*50 = 47.5 -> 48
    });

    it("clamps an out-of-range trust score", () => {
      expect(computePriorityScore({ ...BASE, companyCredibility: 140 }).components?.company_credibility.value).toBe(100);
      expect(computePriorityScore({ ...BASE, companyCredibility: -5 }).components?.company_credibility.value).toBe(0);
    });
  });

  it("eligibilityCapped still forces score 0 while the new factors move the uncapped score", () => {
    const r = computePriorityScore({
      ...BASE,
      technicalFitScore: 90,
      eligibilityCapped: true,
      responseCategory: "offer",
      remoteType: "remote",
    });
    expect(r.score).toBe(0);
    expect(r.uncappedScore).toBeGreaterThan(50);
  });

  it("worked mixed example", () => {
    // response_stage interview 85, tech 80, practical 100, remote 100,
    // employer range 90, credibility 50, urgency (5d) 85, role match 100
    // = .25*85 + .2*100 + .2*80 + .1*100 + .1*90 + .05*50 + .05*85 + .05*100
    // = 21.25 + 20 + 16 + 10 + 9 + 2.5 + 4.25 + 5 = 88
    const r = computePriorityScore({
      technicalFitScore: 80,
      practicalEligibilityScore: 100,
      eligibilityCapped: false,
      responseCategory: "interview",
      remoteType: "remote",
      salary: { min: 60000, max: 80000, source: "employer_disclosed" },
      deadlineDays: 5,
      roleMatch: true,
    });
    expect(r.score).toBe(88);
  });
});

describe("isResponseCategory", () => {
  it("accepts known categories, rejects everything else", () => {
    expect(isResponseCategory("interview")).toBe(true);
    expect(isResponseCategory("offer")).toBe(true);
    expect(isResponseCategory("screening")).toBe(false);
    expect(isResponseCategory(null)).toBe(false);
    expect(isResponseCategory(undefined)).toBe(false);
    expect(isResponseCategory("")).toBe(false);
  });
});

const DAY = 86_400_000;

describe("daysUntil / nearestDeadlineDays", () => {
  it("returns null for absent or unparseable input", () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil(undefined)).toBeNull();
    expect(daysUntil("")).toBeNull();
    expect(daysUntil("not a date")).toBeNull();
  });

  // Half-day offsets keep these off the floor() boundary, so the result does
  // not depend on how many milliseconds elapse between the two Date.now()s.
  it("floors to whole days and goes negative for the past", () => {
    expect(daysUntil(new Date(Date.now() + 5.5 * DAY).toISOString())).toBe(5);
    expect(daysUntil(new Date(Date.now() - 2.5 * DAY).toISOString())).toBe(-3);
  });

  it("nearestDeadlineDays picks the soonest and ignores nulls", () => {
    const soon = new Date(Date.now() + 3.5 * DAY).toISOString();
    const later = new Date(Date.now() + 40.5 * DAY).toISOString();
    expect(nearestDeadlineDays([later, null, soon])).toBe(3);
    expect(nearestDeadlineDays([null, undefined])).toBeNull();
    expect(nearestDeadlineDays([])).toBeNull();
  });
});

describe("finalizeWithFreshUrgency", () => {
  /** A stored breakdown, exactly as analyzeFit would have persisted it. */
  function storedComponents(input: PriorityScoreInput) {
    return computePriorityScore(input).components!;
  }

  it("reproduces the stored score when the fresh urgency matches the snapshot", () => {
    const input: PriorityScoreInput = {
      technicalFitScore: 80,
      practicalEligibilityScore: 100,
      eligibilityCapped: false,
      responseCategory: "interview",
      companyCredibility: 90,
      deadlineDays: null,
    };
    const stored = computePriorityScore(input);
    expect(finalizeWithFreshUrgency(stored.components!, null)).toBe(stored.uncappedScore);
  });

  it("moves only by the urgency slice when the deadline has drawn closer", () => {
    const components = storedComponents({
      technicalFitScore: 80,
      practicalEligibilityScore: 100,
      eligibilityCapped: false,
      deadlineDays: null, // snapshot urgency neutral 50
    });
    // 66 baseline, urgency 50 -> 100 is +0.05*50 = +2.5 -> 68.5 -> 69
    expect(finalizeWithFreshUrgency(components, null)).toBe(66);
    expect(finalizeWithFreshUrgency(components, 1)).toBe(69);
  });

  it("a past deadline drops urgency back to neutral", () => {
    const components = storedComponents({
      technicalFitScore: 80,
      practicalEligibilityScore: 100,
      eligibilityCapped: false,
      deadlineDays: 1, // snapshot urgency 100
    });
    expect(finalizeWithFreshUrgency(components, 1)).toBe(69);
    expect(finalizeWithFreshUrgency(components, -4)).toBe(66);
  });

  it("leaves every non-urgency factor exactly as stored", () => {
    const components = storedComponents({
      technicalFitScore: 0,
      practicalEligibilityScore: 0,
      eligibilityCapped: false,
      responseCategory: "rejection",
      companyCredibility: 0,
      remoteType: "on_site",
      roleMatch: false,
      deadlineDays: null,
    });
    // .25*0 + .2*0 + .2*0 + .1*40 + .1*50 + .05*0 + .05*urgency + .05*50
    // = 4 + 5 + 2.5 + .05*urgency
    expect(finalizeWithFreshUrgency(components, null)).toBe(14); // urgency 50 -> 11.5 + 2.5 = 14
    expect(finalizeWithFreshUrgency(components, 0)).toBe(17); // urgency 100 -> 11.5 + 5 = 16.5 -> 17
  });

  it("re-sums with the STORED weights, not the current ones", () => {
    const components = storedComponents({ ...BASE, deadlineDays: null });
    // Halve every stored weight: the result must halve too (25), proving the
    // stored weights are used rather than FACTOR_WEIGHTS.
    const halved = Object.fromEntries(
      Object.entries(components).map(([k, c]) => [k, { ...c, weight: c.weight / 2 }]),
    ) as typeof components;
    expect(finalizeWithFreshUrgency(halved, null)).toBe(25);
  });

  it("falls back to neutral for a factor missing from a stored breakdown", () => {
    const components = storedComponents({ ...BASE, deadlineDays: null });
    const partial = { ...components } as Record<string, unknown>;
    delete partial.technical_fit;
    expect(finalizeWithFreshUrgency(partial as typeof components, null)).toBe(50);
  });
});
