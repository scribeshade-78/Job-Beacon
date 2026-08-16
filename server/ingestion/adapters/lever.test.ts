import { describe, expect, it, vi } from "vitest";
import { discoverLever } from "./lever.js";

// Fixture shaped from the real response documented at
// https://github.com/lever/postings-api (verified directly, not invented).
const fixtureResponse = [
  {
    id: "abc123-def456",
    text: "Senior Backend Engineer",
    hostedUrl: "https://jobs.lever.co/acme/abc123-def456",
    createdAt: 1785600000000,
    categories: { location: "New York, NY" },
    workplaceType: "hybrid" as const,
    salaryRange: { currency: "USD", interval: "year", min: 140000, max: 180000 },
  },
  {
    id: "ghi789",
    text: "Support Engineer",
    hostedUrl: "https://jobs.lever.co/acme/ghi789",
    categories: { location: "Remote - US" },
    workplaceType: "remote" as const,
  },
];

function fixtureFetch(status = 200, body: unknown = fixtureResponse) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("discoverLever", () => {
  it("requests the correct public site-slug URL in json mode", async () => {
    const fetchImpl = fixtureFetch();

    await discoverLever("acme", { companyName: "Acme Corp" }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://api.lever.co/v0/postings/acme?mode=json");
  });

  it("normalizes postings into DiscoveredVacancy shape, using the real salaryRange/workplaceType fields", async () => {
    const result = await discoverLever("acme", { companyName: "Acme Corp", companyDomain: "acme.example" }, fixtureFetch());

    expect(result[0]).toEqual({
      sourceVacancyId: "abc123-def456",
      authoritativeUrl: "https://jobs.lever.co/acme/abc123-def456",
      rawTitle: "Senior Backend Engineer",
      companyName: "Acme Corp",
      companyDomain: "acme.example",
      country: null,
      region: null,
      city: null,
      remoteType: "hybrid",
      currency: "USD",
      salaryMin: 140000,
      salaryMax: 180000,
      salaryInterval: "year",
      salarySource: "employer_disclosed",
      publishedAt: new Date(1785600000000).toISOString(),
      raw: fixtureResponse[0],
    });
  });

  it("leaves salary fields null when a posting has no salaryRange", async () => {
    const result = await discoverLever("acme", { companyName: "Acme Corp" }, fixtureFetch());

    expect(result[1]).toMatchObject({
      salaryMin: null,
      salaryMax: null,
      salaryInterval: null,
      salarySource: null,
      remoteType: "remote",
    });
  });

  it("throws a clear error on a non-2xx response", async () => {
    await expect(
      discoverLever("nonexistent", { companyName: "Nobody" }, fixtureFetch(404, {})),
    ).rejects.toThrow(/404/);
  });
});
