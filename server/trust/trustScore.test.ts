import { describe, expect, it } from "vitest";
import { computeTrustScore, DIMENSION_WEIGHTS, type TrustScoreSignals } from "./trustScore.js";

const goodSignals: TrustScoreSignals = {
  authoritativeUrl: "https://careers.acme.com/jobs/123",
  companyDomain: "acme.com",
  companyCareerDomain: "careers.acme.com",
  sourceDiscoveryAllowed: true,
  sourceKillSwitch: false,
  redirectIsTls: true,
  vacancyStatus: "active",
  lastSeenAt: "2026-08-17T00:00:00Z",
  now: "2026-08-17T01:00:00Z",
  crossSourceConsistent: true,
  moderatorHistoryClean: true,
  salaryMin: 100000,
  salaryMax: 130000,
  descriptionText: "We are hiring a backend engineer to join our platform team.",
};

function pointsFor(result: ReturnType<typeof computeTrustScore>, name: string): number {
  const dimension = result.dimensions.find((d) => d.name === name);
  if (!dimension) throw new Error(`No dimension named ${name} in result`);
  return dimension.points;
}

function fractionFor(result: ReturnType<typeof computeTrustScore>, name: string): number {
  const dimension = result.dimensions.find((d) => d.name === name);
  if (!dimension) throw new Error(`No dimension named ${name} in result`);
  return dimension.fraction;
}

describe("DIMENSION_WEIGHTS", () => {
  it("sums to exactly 100, matching the verified PRD §12.2 table", () => {
    const total = Object.values(DIMENSION_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBe(100);
  });
});

describe("computeTrustScore", () => {
  it("scores 100 when every dimension is fully favorable", () => {
    expect(computeTrustScore(goodSignals).total).toBe(100);
  });

  it("scores 85 when every not-yet-wired optional signal is simply absent (neutral, not penalized or free-credited)", () => {
    const signals: TrustScoreSignals = {
      ...goodSignals,
      redirectIsTls: undefined,
      crossSourceConsistent: undefined,
      moderatorHistoryClean: undefined,
      descriptionText: undefined,
    };
    expect(computeTrustScore(signals).total).toBe(85);
  });

  describe("employerIdentity (weight 20)", () => {
    it("scores full credit when the hostname matches a known company domain", () => {
      expect(fractionFor(computeTrustScore(goodSignals), "employerIdentity")).toBe(1);
    });

    it("scores zero when no company domain is known at all", () => {
      const signals: TrustScoreSignals = { ...goodSignals, companyDomain: null, companyCareerDomain: null };
      expect(fractionFor(computeTrustScore(signals), "employerIdentity")).toBe(0);
    });

    it("scores zero when the hostname does not match any known domain", () => {
      const signals: TrustScoreSignals = { ...goodSignals, authoritativeUrl: "https://randomjobsite.example/post/1" };
      expect(fractionFor(computeTrustScore(signals), "employerIdentity")).toBe(0);
    });

    it("scores full credit when registry verification is present, even without a domain match", () => {
      const signals: TrustScoreSignals = {
        ...goodSignals,
        authoritativeUrl: "https://randomjobsite.example/post/1",
        registryVerified: true,
      };
      expect(fractionFor(computeTrustScore(signals), "employerIdentity")).toBe(1);
    });
  });

  describe("authoritativeSource (weight 20)", () => {
    it("scores zero when discovery is not allowed for the source", () => {
      const signals: TrustScoreSignals = { ...goodSignals, sourceDiscoveryAllowed: false };
      expect(fractionFor(computeTrustScore(signals), "authoritativeSource")).toBe(0);
    });

    it("scores zero when the source's kill switch is engaged", () => {
      const signals: TrustScoreSignals = { ...goodSignals, sourceKillSwitch: true };
      expect(fractionFor(computeTrustScore(signals), "authoritativeSource")).toBe(0);
    });
  });

  describe("urlIntegrity (weight 15)", () => {
    it("is penalized by half for a domain mismatch alone", () => {
      const signals: TrustScoreSignals = {
        ...goodSignals,
        authoritativeUrl: "https://randomjobsite.example/post/1",
        redirectIsTls: undefined,
      };
      expect(fractionFor(computeTrustScore(signals), "urlIntegrity")).toBe(0.5);
    });

    it("is penalized by half for a non-TLS redirect alone", () => {
      const signals: TrustScoreSignals = { ...goodSignals, redirectIsTls: false };
      expect(fractionFor(computeTrustScore(signals), "urlIntegrity")).toBe(0.5);
    });

    it("is clamped at zero, not negative, when both penalties apply", () => {
      const signals: TrustScoreSignals = {
        ...goodSignals,
        authoritativeUrl: "https://randomjobsite.example/post/1",
        redirectIsTls: false,
      };
      expect(fractionFor(computeTrustScore(signals), "urlIntegrity")).toBe(0);
    });

    it("scores full credit when there is no domain data and no TLS data to evaluate against", () => {
      const signals: TrustScoreSignals = {
        ...goodSignals,
        companyDomain: null,
        companyCareerDomain: null,
        redirectIsTls: undefined,
      };
      expect(fractionFor(computeTrustScore(signals), "urlIntegrity")).toBe(1);
    });
  });

  describe("freshness (weight 10)", () => {
    it("scores zero for an expired vacancy regardless of last-seen time", () => {
      const signals: TrustScoreSignals = { ...goodSignals, vacancyStatus: "expired" };
      expect(fractionFor(computeTrustScore(signals), "freshness")).toBe(0);
    });

    it("scores zero for a removed vacancy regardless of last-seen time", () => {
      const signals: TrustScoreSignals = { ...goodSignals, vacancyStatus: "removed" };
      expect(fractionFor(computeTrustScore(signals), "freshness")).toBe(0);
    });

    it("scores full credit right at the 24-hour boundary", () => {
      const signals: TrustScoreSignals = {
        ...goodSignals,
        lastSeenAt: "2026-08-17T00:00:00Z",
        now: "2026-08-18T00:00:00Z",
      };
      expect(fractionFor(computeTrustScore(signals), "freshness")).toBe(1);
    });

    it("scores zero right at the 168-hour (7-day) boundary", () => {
      const signals: TrustScoreSignals = {
        ...goodSignals,
        lastSeenAt: "2026-08-10T00:00:00Z",
        now: "2026-08-17T00:00:00Z",
      };
      expect(fractionFor(computeTrustScore(signals), "freshness")).toBe(0);
    });

    it("interpolates linearly at the midpoint between the two boundaries", () => {
      const signals: TrustScoreSignals = {
        ...goodSignals,
        lastSeenAt: "2026-08-13T00:00:00Z",
        now: "2026-08-17T00:00:00Z",
      };
      expect(fractionFor(computeTrustScore(signals), "freshness")).toBeCloseTo(0.5, 5);
    });
  });

  describe("contentConsistency (weight 10)", () => {
    it("scores neutral (0.5) when no cross-source comparison signal is available", () => {
      const signals: TrustScoreSignals = { ...goodSignals, crossSourceConsistent: undefined };
      expect(fractionFor(computeTrustScore(signals), "contentConsistency")).toBe(0.5);
    });

    it("scores zero when cross-source fields conflict", () => {
      const signals: TrustScoreSignals = { ...goodSignals, crossSourceConsistent: false };
      expect(fractionFor(computeTrustScore(signals), "contentConsistency")).toBe(0);
    });
  });

  describe("moderatorHistory (weight 10)", () => {
    it("scores neutral (0.5) when no moderation history signal is available", () => {
      const signals: TrustScoreSignals = { ...goodSignals, moderatorHistoryClean: undefined };
      expect(fractionFor(computeTrustScore(signals), "moderatorHistory")).toBe(0.5);
    });

    it("scores zero when prior history is not clean", () => {
      const signals: TrustScoreSignals = { ...goodSignals, moderatorHistoryClean: false };
      expect(fractionFor(computeTrustScore(signals), "moderatorHistory")).toBe(0);
    });
  });

  describe("salaryPlausibility (weight 5)", () => {
    it("scores neutral (0.5) when no salary is disclosed", () => {
      const signals: TrustScoreSignals = { ...goodSignals, salaryMin: null, salaryMax: null };
      expect(fractionFor(computeTrustScore(signals), "salaryPlausibility")).toBe(0.5);
    });

    it("scores zero when min exceeds max", () => {
      const signals: TrustScoreSignals = { ...goodSignals, salaryMin: 150000, salaryMax: 100000 };
      expect(fractionFor(computeTrustScore(signals), "salaryPlausibility")).toBe(0);
    });

    it("scores zero for a non-positive value", () => {
      const signals: TrustScoreSignals = { ...goodSignals, salaryMin: -5000 };
      expect(fractionFor(computeTrustScore(signals), "salaryPlausibility")).toBe(0);
    });

    it("scores full credit for a single positive value with the other side absent", () => {
      const signals: TrustScoreSignals = { ...goodSignals, salaryMin: 100000, salaryMax: null };
      expect(fractionFor(computeTrustScore(signals), "salaryPlausibility")).toBe(1);
    });
  });

  describe("scamSignals (weight 10)", () => {
    it("scores neutral (0.5) when no description text is available", () => {
      const signals: TrustScoreSignals = { ...goodSignals, descriptionText: undefined };
      expect(fractionFor(computeTrustScore(signals), "scamSignals")).toBe(0.5);
    });

    it("scores zero for hard-block-tier scam language", () => {
      const signals: TrustScoreSignals = {
        ...goodSignals,
        descriptionText: "A small registration fee is required before you can start.",
      };
      expect(fractionFor(computeTrustScore(signals), "scamSignals")).toBe(0);
    });

    it("scores a partial penalty for softer scam-adjacent language", () => {
      const signals: TrustScoreSignals = {
        ...goodSignals,
        descriptionText: "We may ask you to complete a wire transfer as part of onboarding.",
      };
      expect(fractionFor(computeTrustScore(signals), "scamSignals")).toBe(0.4);
    });

    it("scores full credit for clean description text", () => {
      expect(fractionFor(computeTrustScore(goodSignals), "scamSignals")).toBe(1);
    });
  });

  it("reports each dimension's weight, fraction, and points consistently", () => {
    const result = computeTrustScore(goodSignals);
    for (const dimension of result.dimensions) {
      expect(dimension.points).toBeCloseTo(dimension.weight * dimension.fraction, 10);
    }
    expect(pointsFor(result, "employerIdentity")).toBe(20);
    expect(pointsFor(result, "salaryPlausibility")).toBe(5);
  });
});
