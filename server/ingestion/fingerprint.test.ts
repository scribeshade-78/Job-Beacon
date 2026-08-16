import { describe, expect, it } from "vitest";
import { computeContentHash, computeFingerprint } from "./fingerprint.js";

function makeVacancy(overrides: Partial<Parameters<typeof computeFingerprint>[0]> = {}) {
  return {
    sourceVacancyId: "1",
    authoritativeUrl: "https://example.com/1",
    rawTitle: "Backend Engineer",
    companyName: "Acme Corp",
    companyDomain: null,
    country: "US",
    region: null,
    city: null,
    remoteType: null,
    currency: null,
    salaryMin: null,
    salaryMax: null,
    salaryInterval: null,
    salarySource: null,
    publishedAt: "2026-08-11T00:00:00Z",
    raw: {},
    ...overrides,
  };
}

describe("computeContentHash", () => {
  it("is deterministic for the same payload", () => {
    const payload = { a: 1, b: "x" };
    expect(computeContentHash(payload)).toBe(computeContentHash(payload));
  });

  it("differs for different payloads", () => {
    expect(computeContentHash({ a: 1 })).not.toBe(computeContentHash({ a: 2 }));
  });
});

describe("computeFingerprint", () => {
  it("is identical for two listings with the same company/title/country/publish-week", () => {
    const a = makeVacancy({ publishedAt: "2026-08-11T00:00:00Z" });
    const b = makeVacancy({ publishedAt: "2026-08-13T00:00:00Z" });

    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });

  it("is case- and whitespace-insensitive on company and title", () => {
    const a = makeVacancy({ companyName: "Acme Corp", rawTitle: "Backend  Engineer" });
    const b = makeVacancy({ companyName: "acme corp", rawTitle: "backend engineer" });

    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });

  it("differs when the company differs", () => {
    const a = makeVacancy({ companyName: "Acme Corp" });
    const b = makeVacancy({ companyName: "Other Corp" });

    expect(computeFingerprint(a)).not.toBe(computeFingerprint(b));
  });

  it("differs when the publish week differs", () => {
    const a = makeVacancy({ publishedAt: "2026-08-11T00:00:00Z" });
    const b = makeVacancy({ publishedAt: "2026-09-01T00:00:00Z" });

    expect(computeFingerprint(a)).not.toBe(computeFingerprint(b));
  });

  it("falls back to 'unknown' publish-window without throwing when publishedAt is null", () => {
    const vacancy = makeVacancy({ publishedAt: null });
    expect(() => computeFingerprint(vacancy)).not.toThrow();
  });
});
