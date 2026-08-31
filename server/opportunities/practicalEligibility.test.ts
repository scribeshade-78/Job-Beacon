import { describe, expect, it } from "vitest";
import {
  evaluatePracticalEligibility,
  eligibilityInfoCode,
  type PracticalEligibilityInput,
} from "./practicalEligibility.js";

function input(over: {
  candidateLocation?: string | null;
  vacancy?: Partial<PracticalEligibilityInput["vacancy"]>;
} = {}): PracticalEligibilityInput {
  const v = over.vacancy ?? {};
  return {
    candidateLocation: over.candidateLocation === undefined ? "Bengaluru, India" : over.candidateLocation,
    vacancy: {
      country: "country" in v ? (v.country ?? null) : "India",
      region: v.region ?? null,
      city: v.city ?? null,
      remoteType: "remoteType" in v ? (v.remoteType ?? null) : "on_site",
    },
  };
}

describe("evaluatePracticalEligibility", () => {
  it("remote role: always eligible, score 100, no blockers", () => {
    const r = evaluatePracticalEligibility(input({ candidateLocation: "Nowhere", vacancy: { remoteType: "remote", country: "United States" } }));
    expect(r).toEqual({ score: 100, hardBlockers: [], softPenalties: [] });
  });

  it("non-remote, same country (via alias): eligible, score 100", () => {
    const r = evaluatePracticalEligibility(input({ candidateLocation: "San Francisco, CA, USA", vacancy: { country: "United States", remoteType: "on_site" } }));
    expect(r.score).toBe(100);
    expect(r.hardBlockers).toEqual([]);
  });

  it("non-remote, different country: LOCATION_PRESENCE hard blocker caps to 0", () => {
    const r = evaluatePracticalEligibility(input({ candidateLocation: "Bengaluru, India", vacancy: { country: "United States", remoteType: "on_site" } }));
    expect(r.score).toBe(0);
    expect(r.hardBlockers).toHaveLength(1);
    expect(r.hardBlockers[0].code).toBe("LOCATION_PRESENCE");
  });

  it("non-remote, vacancy has no country: eligible (don't penalise missing source data), with LOCATION_UNKNOWN info", () => {
    const inp = input({ candidateLocation: "Bengaluru, India", vacancy: { country: null, remoteType: "on_site" } });
    const r = evaluatePracticalEligibility(inp);
    expect(r.score).toBe(100);
    expect(r.hardBlockers).toEqual([]);
    expect(eligibilityInfoCode(inp, r)?.code).toBe("LOCATION_UNKNOWN");
  });

  it("non-remote, candidate has no confirmed location fact: score null, INSUFFICIENT_DATA, not a blocker", () => {
    const inp = input({ candidateLocation: null, vacancy: { country: "India", remoteType: "hybrid" } });
    const r = evaluatePracticalEligibility(inp);
    expect(r.score).toBeNull();
    expect(r.hardBlockers).toEqual([]);
    expect(eligibilityInfoCode(inp, r)?.code).toBe("INSUFFICIENT_DATA");
  });
});
