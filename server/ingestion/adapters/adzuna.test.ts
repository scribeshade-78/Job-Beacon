import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverAdzuna, adzunaAdapter } from "./adzuna.js";

// Fixture shaped from the real response documented at
// https://developer.adzuna.com/docs/search (verified directly, not invented).
const fixtureResponse = {
  results: [
    {
      id: "4820001234",
      title: "Full Stack Developer",
      company: { display_name: "Acme Corp" },
      location: { display_name: "London, South East England" },
      salary_min: 55000,
      salary_max: 70000,
      created: "2026-08-01T10:00:00Z",
      redirect_url: "https://www.adzuna.co.uk/land/ad/4820001234",
    },
    {
      id: "4820005678",
      title: "QA Engineer",
      redirect_url: "https://www.adzuna.co.uk/land/ad/4820005678",
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

const credentials = { appId: "test-app-id", appKey: "test-app-key" };

describe("discoverAdzuna", () => {
  it("throws a config-boundary error and never calls fetch when credentials are missing", async () => {
    const fetchImpl = fixtureFetch();

    await expect(discoverAdzuna("gb", {}, { appId: "", appKey: "" }, fetchImpl)).rejects.toThrow(
      /app_id and app_key/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requests the correct country-specific search URL with credentials as query params", async () => {
    const fetchImpl = fixtureFetch();

    await discoverAdzuna("gb", { what: "developer" }, credentials, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=test-app-id&app_key=test-app-key&what=developer",
      { headers: { Accept: "application/json" } },
    );
  });

  it("normalizes results into DiscoveredVacancy shape, taking company name from each result", async () => {
    const result = await discoverAdzuna("gb", {}, credentials, fixtureFetch());

    expect(result[0]).toEqual({
      sourceVacancyId: "4820001234",
      authoritativeUrl: "https://www.adzuna.co.uk/land/ad/4820001234",
      rawTitle: "Full Stack Developer",
      companyName: "Acme Corp",
      companyDomain: null,
      country: "GB",
      region: null,
      city: null,
      remoteType: null,
      currency: null,
      salaryMin: 55000,
      salaryMax: 70000,
      salaryInterval: "year",
      salarySource: "estimated",
      publishedAt: "2026-08-01T10:00:00Z",
      raw: fixtureResponse.results[0],
    });
  });

  it("defaults companyName to 'Unknown' and leaves salary null when absent", async () => {
    const result = await discoverAdzuna("gb", {}, credentials, fixtureFetch());

    expect(result[1].companyName).toBe("Unknown");
    expect(result[1].salaryMin).toBeNull();
    expect(result[1].salaryInterval).toBeNull();
  });

  it("throws a clear error on a non-2xx response", async () => {
    await expect(discoverAdzuna("gb", {}, credentials, fixtureFetch(401, {}))).rejects.toThrow(/401/);
  });
});

describe("adzunaAdapter (MP-A2.1 registry wrapper)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("has the expected sourceCode", () => {
    expect(adzunaAdapter.sourceCode).toBe("adzuna");
  });

  it("validateConfig accepts any config — no required target-level fields", () => {
    expect(() => adzunaAdapter.validateConfig({})).not.toThrow();
    expect(() => adzunaAdapter.validateConfig({ what: "developer" })).not.toThrow();
  });

  it("reads credentials from process.env and delegates to discoverAdzuna, targetKey as countryCode", async () => {
    vi.stubEnv("ADZUNA_APP_ID", "env-app-id");
    vi.stubEnv("ADZUNA_APP_KEY", "env-app-key");
    const fetchImpl = fixtureFetch();

    await adzunaAdapter.discover("gb", { what: "developer" }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=env-app-id&app_key=env-app-key&what=developer",
      { headers: { Accept: "application/json" } },
    );
  });

  it("throws when env credentials are missing — same behavior as before this phase", async () => {
    vi.stubEnv("ADZUNA_APP_ID", "");
    vi.stubEnv("ADZUNA_APP_KEY", "");
    const fetchImpl = fixtureFetch();

    await expect(adzunaAdapter.discover("gb", {}, fetchImpl)).rejects.toThrow(/app_id and app_key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Adzuna structured location (captured from real 200s)", () => {
  const withLocation = (location: Record<string, unknown>) =>
    (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            id: "1",
            title: "Engineer",
            redirect_url: "https://example.test/1",
            company: { display_name: "Kannanware" },
            location,
          },
        ],
      }),
    })) as unknown as Parameters<typeof discoverAdzuna>[3];

  it("reads the city from location.area[2] - the field this adapter never declared", async () => {
    // Real payload: area ["India","Tamil Nadu","Bangalore"], display_name
    // "Bangalore, Karnataka". BEFORE this change the mapper returned city: null for
    // every Adzuna row, which is why Phase 2 had no cities to offer.
    const [row] = await discoverAdzuna(
      "in",
      { resultsPerPage: 1 },
      { appId: "a", appKey: "k" },
      withLocation({ display_name: "Bangalore, Karnataka", area: ["India", "Tamil Nadu", "Bangalore"] }),
    );

    expect(row.city).toBe("Bangalore");
    expect(row.country).toBe("IN");
  });

  it("returns null rather than inventing a city when area carries only a country", async () => {
    // Real payload: area ["India"] - one element, no city. The ?? null is load-bearing.
    const [row] = await discoverAdzuna(
      "in",
      { resultsPerPage: 1 },
      { appId: "a", appKey: "k" },
      withLocation({ display_name: "India", area: ["India"] }),
    );

    expect(row.city).toBeNull();
  });

  it("returns null when there is no area at all, instead of decomposing display_name", async () => {
    // display_name IS free text ("London, South East England") and the mapper still
    // refuses to guess a city out of it. Only the structured array is trusted.
    const [row] = await discoverAdzuna(
      "gb",
      { resultsPerPage: 1 },
      { appId: "a", appKey: "k" },
      withLocation({ display_name: "London, South East England" }),
    );

    expect(row.city).toBeNull();
    expect(row.country).toBe("GB");
  });
});

/**
 * Phase 8 — payload hardening.
 *
 * The mapper above was written against the DOCUMENTED shape and a couple of real
 * 200s. These cover the shapes a live aggregator actually produces: a body whose
 * `results` key is missing entirely, a body whose `results` is not an array, rows
 * that cannot be identified or linked, and a non-2xx whose body explains why.
 */
describe("Adzuna payload hardening", () => {
  function page(results: unknown[]) {
    return (async () => ({ ok: true, status: 200, json: async () => ({ results }) })) as unknown as typeof fetch;
  }

  it("throws a payload error, not an unchecked TypeError, when results is not an array", async () => {
    // Previously: `body.results.map` on a missing key threw "Cannot read properties
    // of undefined (reading 'map')" — a stack trace that names our own code rather
    // than the provider's payload, and which the ingestion worker records verbatim
    // as the source's health error.
    await expect(discoverAdzuna("gb", {}, credentials, fixtureFetch(200, {}))).rejects.toThrow(/results/i);
    await expect(
      discoverAdzuna("gb", {}, credentials, fixtureFetch(200, { results: "nope" })),
    ).rejects.toThrow(/results/i);
  });

  it("skips a row that cannot be identified or linked instead of writing undefined into NOT NULL columns", async () => {
    // vacancies.source_vacancy_id / authoritative_url / raw_title are NOT NULL, so a
    // row without them is either a failed insert or a garbage vacancy. The other
    // adapters skip and move on; this one must too.
    const rows = await discoverAdzuna(
      "gb",
      {},
      credentials,
      page([
        { id: "1", title: "Engineer", redirect_url: "https://adzuna.test/1" },
        { title: "No id", redirect_url: "https://adzuna.test/2" },
        { id: "3", title: "No url" },
        { id: "4", redirect_url: "https://adzuna.test/4" },
        { id: 5, title: "Numeric id", redirect_url: "https://adzuna.test/5" },
      ]),
    );

    expect(rows.map((row) => row.sourceVacancyId)).toEqual(["1", "5"]);
    expect(rows.every((row) => typeof row.authoritativeUrl === "string" && row.authoritativeUrl !== "")).toBe(true);
  });

  it("labels an explicitly disclosed salary employer_disclosed, not estimated", async () => {
    // Adzuna's salary_is_predicted is the STRING "0" when the employer stated the figure
    // and "1" when Adzuna predicted it. Ignoring it labelled disclosed salaries
    // "estimated", which is wrong twice over: the UI prints "(estimated)" for a salary the
    // employer published, AND priorityScore scores estimated at 50 where employer_disclosed
    // is worth 90 (range) or 70 (single figure) — so those vacancies ranked lower for the
    // wrong reason.
    const rows = await discoverAdzuna(
      "gb",
      {},
      credentials,
      page([
        {
          id: "1",
          title: "Engineer",
          redirect_url: "https://adzuna.test/1",
          salary_min: 60000,
          salary_max: 80000,
          salary_is_predicted: "0",
        },
        {
          id: "2",
          title: "Engineer",
          redirect_url: "https://adzuna.test/2",
          salary_min: 60000,
          salary_max: 80000,
          salary_is_predicted: "1",
        },
      ]),
    );

    expect(rows[0].salarySource).toBe("employer_disclosed");
    expect(rows[1].salarySource).toBe("estimated");
  });

  it("stays conservatively estimated when the predicted flag is absent or unrecognised", async () => {
    // Only an explicit "not predicted" may promote a figure to disclosed. An absent or
    // unrecognised flag must not: claiming the employer stated a salary they did not is
    // worse than under-claiming it.
    const rows = await discoverAdzuna(
      "gb",
      {},
      credentials,
      page([
        { id: "1", title: "E", redirect_url: "https://adzuna.test/1", salary_min: 1, salary_max: 2 },
        {
          id: "2",
          title: "E",
          redirect_url: "https://adzuna.test/2",
          salary_min: 1,
          salary_max: 2,
          salary_is_predicted: "maybe",
        },
        {
          id: "3",
          title: "E",
          redirect_url: "https://adzuna.test/3",
          salary_min: 1,
          salary_max: 2,
          salary_is_predicted: 0,
        },
      ]),
    );

    expect(rows[0].salarySource).toBe("estimated");
    expect(rows[1].salarySource).toBe("estimated");
    // Numeric 0 as well as the string "0": the live API sends strings today, but a shape
    // change must not silently start under-ranking disclosed salaries again.
    expect(rows[2].salarySource).toBe("employer_disclosed");
  });

  it("leaves the source null when there is no figure, whatever the flag says", async () => {
    // 8 of the 30 live rows looked exactly like this: salary_is_predicted="0" with no
    // salary at all. Null is correct — "not predicted" is not a salary.
    const [row] = await discoverAdzuna(
      "gb",
      {},
      credentials,
      page([{ id: "1", title: "E", redirect_url: "https://adzuna.test/1", salary_is_predicted: "0" }]),
    );

    expect(row.salarySource).toBeNull();
    expect(row.salaryMin).toBeNull();
    expect(row.salaryInterval).toBeNull();
  });

  it("reads region from location.area[1] - the same structured array the city already trusts", async () => {
    // area is ["India","Tamil Nadu","Bangalore"] on real payloads. city already comes
    // from area[2]; leaving region null while the state sits one slot away is a
    // mapping gap, not a source limitation.
    const [row] = await discoverAdzuna(
      "in",
      { resultsPerPage: 1 },
      credentials,
      page([
        {
          id: "1",
          title: "Engineer",
          redirect_url: "https://adzuna.test/1",
          location: { display_name: "Bangalore, Karnataka", area: ["India", "Tamil Nadu", "Bangalore"] },
        },
      ]),
    );

    expect(row.region).toBe("Tamil Nadu");
    expect(row.city).toBe("Bangalore");
  });

  it("returns a null region rather than inventing one when area is short", async () => {
    const [row] = await discoverAdzuna(
      "in",
      {},
      credentials,
      page([
        { id: "1", title: "Engineer", redirect_url: "https://adzuna.test/1", location: { area: ["India"] } },
      ]),
    );

    expect(row.region).toBeNull();
  });

  it("does not claim an annual salary when the provider sent an explicit null", async () => {
    // `salary_min: null` is PRESENT, so a `!== undefined` check marked the row as an
    // annual estimate while every salary field stayed null — a vacancy advertised as
    // "salary known" with no salary on it.
    const rows = await discoverAdzuna(
      "gb",
      {},
      credentials,
      page([{ id: "1", title: "Engineer", redirect_url: "https://adzuna.test/1", salary_min: null, salary_max: null }]),
    );

    expect(rows[0].salaryMin).toBeNull();
    expect(rows[0].salaryInterval).toBeNull();
    expect(rows[0].salarySource).toBeNull();
  });

  it("surfaces the provider's own error detail on a non-2xx response", async () => {
    // Adzuna answers a bad key with { exception: ... }. "HTTP 401" alone sends the
    // operator to the Adzuna dashboard with nothing to search for.
    await expect(
      discoverAdzuna("gb", {}, credentials, fixtureFetch(401, { exception: "invalid app_key" })),
    ).rejects.toThrow(/invalid app_key/);
  });
});
