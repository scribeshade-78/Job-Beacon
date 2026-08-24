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
