import { describe, expect, it, vi } from "vitest";
import { leverAdapter } from "./lever.js";

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

describe("leverAdapter", () => {
  it("has the correct sourceCode", () => {
    expect(leverAdapter.sourceCode).toBe("lever");
  });

  it("requests the correct public site-slug URL in json mode", async () => {
    const fetchImpl = fixtureFetch();

    await leverAdapter.discover("acme", { companyName: "Acme Corp" }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://api.lever.co/v0/postings/acme?mode=json");
  });

  it("normalizes postings into DiscoveredVacancy shape, using the real salaryRange/workplaceType fields", async () => {
    const result = await leverAdapter.discover("acme", { companyName: "Acme Corp", companyDomain: "acme.example" }, fixtureFetch());

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
    const result = await leverAdapter.discover("acme", { companyName: "Acme Corp" }, fixtureFetch());

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
      leverAdapter.discover("nonexistent", { companyName: "Nobody" }, fixtureFetch(404, {})),
    ).rejects.toThrow(/404/);
  });

  it("validateConfig throws when companyName is missing", () => {
    expect(() => leverAdapter.validateConfig({ companyName: "" })).toThrow(/companyName/);
    expect(() => leverAdapter.validateConfig({ companyName: "  " })).toThrow(/companyName/);
    expect(() => leverAdapter.validateConfig({} as never)).toThrow(/companyName/);
  });

  it("validateConfig passes when companyName is valid", () => {
    expect(() => leverAdapter.validateConfig({ companyName: "Acme Corp" })).not.toThrow();
    expect(() => leverAdapter.validateConfig({ companyName: "Acme Corp", companyDomain: "acme.com" })).not.toThrow();
  });
});

/** Phase 8 — payload hardening, same class as Greenhouse, Adzuna and USAJOBS. */
describe("Lever payload hardening", () => {
  const payloadError = /Lever returned a payload/;
  const config = { companyName: "Acme Corp" };

  function page(postings: unknown[]) {
    return (async () => ({ ok: true, status: 200, json: async () => postings })) as unknown as typeof fetch;
  }

  it("throws a payload error, not a TypeError, when the body is not an array", async () => {
    // Lever answers with a BARE ARRAY, so an error object or a null body would make .map
    // itself the TypeError.
    await expect(leverAdapter.discover("acme", config, fixtureFetch(200, null))).rejects.toThrow(payloadError);
    await expect(leverAdapter.discover("acme", config, fixtureFetch(200, {}))).rejects.toThrow(payloadError);
  });

  it("throws a payload error when the body is not JSON at all", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }) as unknown as typeof fetch;

    await expect(leverAdapter.discover("acme", config, fetchImpl)).rejects.toThrow(payloadError);
  });

  it("skips a posting without an id, title or hosted URL", async () => {
    const rows = await leverAdapter.discover(
      "acme",
      config,
      page([
        { id: "1", text: "Analyst", hostedUrl: "https://x/1" },
        { text: "No id", hostedUrl: "https://x/2" },
        { id: "3", hostedUrl: "https://x/3" },
        { id: "4", text: "No url" },
        {},
        null,
      ]),
    );

    expect(rows.map((row) => row.sourceVacancyId)).toEqual(["1"]);
  });

  it("does not claim a disclosed salary when salaryRange carries no figure", async () => {
    // The old truthiness test counted an EMPTY salaryRange object, so the row advertised
    // an employer-disclosed salary with every amount null.
    const [row] = await leverAdapter.discover(
      "acme",
      config,
      page([{ id: "1", text: "Analyst", hostedUrl: "https://x/1", salaryRange: {} }]),
    );

    expect(row.salarySource).toBeNull();
    expect(row.currency).toBeNull();
  });

  it("ignores salary bounds that are not finite numbers", async () => {
    const [row] = await leverAdapter.discover(
      "acme",
      config,
      page([
        {
          id: "1",
          text: "Analyst",
          hostedUrl: "https://x/1",
          salaryRange: { currency: "USD", interval: "year", min: "140000", max: null },
        },
      ]),
    );

    expect(row.salaryMin).toBeNull();
    expect(row.salaryMax).toBeNull();
    expect(row.salaryInterval).toBeNull();
    expect(row.salarySource).toBeNull();
  });

  it("keeps the row when createdAt cannot be parsed, instead of failing the whole batch", async () => {
    // new Date("not-a-date").toISOString() throws RangeError, and a row-level throw here
    // costs every other posting in the same response.
    const [row] = await leverAdapter.discover(
      "acme",
      config,
      page([{ id: "1", text: "Analyst", hostedUrl: "https://x/1", createdAt: "not-a-date" }]),
    );

    expect(row.publishedAt).toBeNull();
  });
});

/**
 * Mapping verified against the REAL leverdemo board (10 postings, every assumed field
 * present, nothing skipped). Two fields were being dropped, both confirmed by the live
 * payload rather than inferred.
 */
describe("Lever live-verified workplace and salary mapping", () => {
  const config = { companyName: "Acme Corp" };

  function page(postings: unknown[]) {
    return (async () => ({ ok: true, status: 200, json: async () => postings })) as unknown as typeof fetch;
  }

  it("maps workplaceType, including the real spelling onsite", async () => {
    // Live distribution: {"hybrid":3,"onsite":3,"remote":3,"unspecified":1}. The map only
    // carried the hyphenated "on-site", so a third of the demo board lost its work mode.
    const rows = await leverAdapter.discover(
      "acme",
      config,
      page([
        { id: "1", text: "A", hostedUrl: "https://x/1", workplaceType: "remote" },
        { id: "2", text: "B", hostedUrl: "https://x/2", workplaceType: "hybrid" },
        { id: "3", text: "C", hostedUrl: "https://x/3", workplaceType: "onsite" },
        { id: "4", text: "D", hostedUrl: "https://x/4", workplaceType: "on-site" },
        { id: "5", text: "E", hostedUrl: "https://x/5", workplaceType: "unspecified" },
      ]),
    );

    expect(rows.map((row) => row.remoteType)).toEqual([
      "remote",
      "hybrid",
      "on_site",
      "on_site",
      // "unspecified" is a real Lever value meaning the poster did not say; null, not on_site.
      null,
    ]);
  });

  it("maps the compound salary interval Lever actually sends", async () => {
    // Live salaryRange.interval is always "per-year-salary"; the exact-key map held only
    // bare units (year/annual/month/hour/...), so EVERY posting with a salary lost its
    // interval while keeping its amounts.
    const rows = await leverAdapter.discover(
      "acme",
      config,
      page([
        { id: "1", text: "A", hostedUrl: "https://x/1", salaryRange: { min: 85000, max: 175000, currency: "USD", interval: "per-year-salary" } },
        { id: "2", text: "B", hostedUrl: "https://x/2", salaryRange: { min: 40, max: 60, currency: "USD", interval: "per-hour-wage" } },
        { id: "3", text: "C", hostedUrl: "https://x/3", salaryRange: { min: 5000, max: 6000, currency: "USD", interval: "per-month-salary" } },
        { id: "4", text: "D", hostedUrl: "https://x/4", salaryRange: { min: 1, max: 2, currency: "USD", interval: "per-fortnight-stipend" } },
      ]),
    );

    expect(rows.map((row) => row.salaryInterval)).toEqual(["year", "hour", "month", null]);
    expect(rows[0].salaryMin).toBe(85000);
    expect(rows[0].salarySource).toBe("employer_disclosed");
  });
});