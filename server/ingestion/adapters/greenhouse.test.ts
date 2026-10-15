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

/**
 * Phase 8 — payload hardening, the same class Adzuna and USAJOBS just went through.
 *
 * This adapter's target rows are ENABLED with live board tokens, so every shape below is
 * reachable from the ingestion drain.
 */
describe("Greenhouse payload hardening", () => {
  const payloadError = /Greenhouse returned a payload/;
  const config = { companyName: "Acme Corp" };

  function page(jobs: unknown[]) {
    return (async () => ({ ok: true, status: 200, json: async () => ({ jobs }) })) as unknown as typeof fetch;
  }

  it("throws a payload error, not a TypeError, when the body is null or jobs is missing", async () => {
    await expect(greenhouseAdapter.discover("acme", config, fixtureFetch(200, null))).rejects.toThrow(payloadError);
    await expect(greenhouseAdapter.discover("acme", config, fixtureFetch(200, {}))).rejects.toThrow(payloadError);
    await expect(
      greenhouseAdapter.discover("acme", config, fixtureFetch(200, { jobs: "nope" })),
    ).rejects.toThrow(payloadError);
  });

  it("throws a payload error when the body is not JSON at all", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }) as unknown as typeof fetch;

    await expect(greenhouseAdapter.discover("acme", config, fetchImpl)).rejects.toThrow(payloadError);
  });

  it("skips a row without an id, title or URL, and never maps a missing id to the string 'undefined'", async () => {
    // THE TRAP THIS ADAPTER HAD. String(undefined) is the literal text undefined: a
    // non-null, entirely plausible source_vacancy_id. Because vacancies is unique on
    // (source_code, source_vacancy_id), every malformed row would have collapsed onto ONE
    // vacancy — silent corruption rather than a failed insert.
    const rows = await greenhouseAdapter.discover(
      "acme",
      config,
      page([
        { id: 1, title: "Analyst", absolute_url: "https://x/1" },
        { title: "No id", absolute_url: "https://x/2" },
        { id: 3, absolute_url: "https://x/3" },
        { id: 4, title: "No url" },
        { id: "", title: "Blank id", absolute_url: "https://x/5" },
        {},
        null,
      ]),
    );

    expect(rows.map((row) => row.sourceVacancyId)).toEqual(["1"]);
  });
});