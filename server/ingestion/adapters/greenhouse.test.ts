import { describe, expect, it, vi } from "vitest";
import { greenhouseAdapter } from "./greenhouse.js";

// Fixture shaped from the real response documented at
// https://developers.greenhouse.io/job-board.html (verified directly, not
// invented) — a subset of fields this adapter actually reads.
const fixtureResponse = {
  jobs: [
    {
      id: 4020000001,
      title: "Backend Engineer",
      updated_at: "2026-08-01T12:00:00-05:00",
      absolute_url: "https://boards.greenhouse.io/acme/jobs/4020000001",
      location: { name: "Remote" },
    },
    {
      id: 4020000002,
      title: "Product Designer",
      updated_at: "2026-08-02T09:30:00-05:00",
      absolute_url: "https://boards.greenhouse.io/acme/jobs/4020000002",
      location: { name: "San Francisco, CA" },
    },
  ],
};

function fixtureFetch(status = 200, body: unknown = fixtureResponse) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("greenhouseAdapter", () => {
  it("has the correct sourceCode", () => {
    expect(greenhouseAdapter.sourceCode).toBe("greenhouse");
  });

  it("requests the correct public board-token URL with no auth header", async () => {
    const fetchImpl = fixtureFetch();

    await greenhouseAdapter.discover("acme", { companyName: "Acme Corp" }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
    );
  });

  it("normalizes jobs into DiscoveredVacancy shape", async () => {
    const result = await greenhouseAdapter.discover("acme", { companyName: "Acme Corp", companyDomain: "acme.example" }, fixtureFetch());

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      sourceVacancyId: "4020000001",
      authoritativeUrl: "https://boards.greenhouse.io/acme/jobs/4020000001",
      rawTitle: "Backend Engineer",
      companyName: "Acme Corp",
      companyDomain: "acme.example",
      country: null,
      region: null,
      city: null,
      remoteType: "remote",
      currency: null,
      salaryMin: null,
      salaryMax: null,
      salaryInterval: null,
      salarySource: null,
      publishedAt: "2026-08-01T12:00:00-05:00",
      raw: fixtureResponse.jobs[0],
    });
  });

  it("only infers remoteType for an exact 'Remote' match, leaving other locations null", async () => {
    const result = await greenhouseAdapter.discover("acme", { companyName: "Acme Corp" }, fixtureFetch());

    expect(result[1].remoteType).toBeNull();
    expect(result[1].country).toBeNull();
  });

  it("defaults companyDomain to null when not supplied in target config", async () => {
    const result = await greenhouseAdapter.discover("acme", { companyName: "Acme Corp" }, fixtureFetch());

    expect(result[0].companyDomain).toBeNull();
  });

  it("throws a clear error on a non-2xx response", async () => {
    await expect(
      greenhouseAdapter.discover("nonexistent", { companyName: "Nobody" }, fixtureFetch(404, {})),
    ).rejects.toThrow(/404/);
  });

  it("validateConfig throws when companyName is missing", () => {
    expect(() => greenhouseAdapter.validateConfig({ companyName: "" })).toThrow(/companyName/);
    expect(() => greenhouseAdapter.validateConfig({ companyName: "  " })).toThrow(/companyName/);
    expect(() => greenhouseAdapter.validateConfig({} as never)).toThrow(/companyName/);
  });

  it("validateConfig passes when companyName is valid", () => {
    expect(() => greenhouseAdapter.validateConfig({ companyName: "Acme Corp" })).not.toThrow();
    expect(() => greenhouseAdapter.validateConfig({ companyName: "Acme Corp", companyDomain: "acme.com" })).not.toThrow();
  });
});