import { afterEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import { adzunaIntakeAdapter } from "./adzunaIntake.js";

/**
 * The wrapper's own behavior: the required-country throw, the delegation into
 * discoverAdzuna (including that the country reaches the URL path), and the
 * IntakeFetchResult it returns.
 *
 * discoverAdzuna's normalization is covered by
 * server/ingestion/adapters/adzuna.test.ts and not re-tested here.
 *
 * fetchImpl is injected exactly as the ingestion adapter's own tests do.
 */
const fixtureResponse = {
  results: [
    {
      id: "4820001234",
      title: "Data Engineer",
      company: { display_name: "Acme Corp" },
      location: { display_name: "London, South East England" },
      salary_min: 55000,
      salary_max: 70000,
      created: "2026-08-01T10:00:00Z",
      redirect_url: "https://www.adzuna.co.uk/land/ad/4820001234",
    },
  ],
};

/**
 * Typed as MockedFunction<typeof fetch> rather than cast to `typeof fetch`: the
 * cast would erase `.mock`, and these cases assert on the exact request URL.
 */
function fixtureFetch(status = 200, body: unknown = fixtureResponse): MockedFunction<typeof fetch> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as MockedFunction<typeof fetch>;
}

/** Every adapter test needs a credential pair; discoverAdzuna rejects a blank one. */
function withCredentials() {
  vi.stubEnv("ADZUNA_APP_ID", "test-app-id");
  vi.stubEnv("ADZUNA_APP_KEY", "test-app-key");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("adzunaIntakeAdapter — required parameters", () => {
  it("throws when the country is missing, without making a request", async () => {
    withCredentials();
    const fetchImpl = fixtureFetch();

    await expect(
      adzunaIntakeAdapter.fetchLiveJobs({ limit: 20, keywords: "Data Engineer" }, fetchImpl),
    ).rejects.toThrow(/requires a two-letter country code/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only country as missing", async () => {
    withCredentials();
    const fetchImpl = fixtureFetch();

    await expect(
      adzunaIntakeAdapter.fetchLiveJobs({ limit: 20, keywords: "Data Engineer", country: "  " }, fetchImpl),
    ).rejects.toThrow(/requires a two-letter country code/);
  });

  it("names the source code the policy row must carry", () => {
    expect(adzunaIntakeAdapter.sourceCode).toBe("adzuna");
  });
});

describe("adzunaIntakeAdapter — delegation", () => {
  it("puts the country in the request path and the keywords in `what`", async () => {
    withCredentials();
    const fetchImpl = fixtureFetch();

    await adzunaIntakeAdapter.fetchLiveJobs(
      { limit: 20, keywords: "Data Engineer", country: "gb" },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=test-app-id&app_key=test-app-key&what=Data+Engineer&results_per_page=20",
    );
  });

  it("sends the same combined role-keyword string Jooble receives", async () => {
    withCredentials();
    const fetchImpl = fixtureFetch();

    await adzunaIntakeAdapter.fetchLiveJobs(
      { limit: 20, keywords: "Data Engineer, Data Analyst", country: "us" },
      fetchImpl,
    );

    expect(fetchImpl.mock.calls[0][0]).toContain("what=Data+Engineer%2C+Data+Analyst");
  });

  it("omits `what` entirely when the candidate has no selected roles", async () => {
    withCredentials();
    const fetchImpl = fixtureFetch();

    await adzunaIntakeAdapter.fetchLiveJobs({ limit: 20, country: "us" }, fetchImpl);

    // Adzuna treats an absent `what` as "everything in this country"; an empty
    // one would be a value it had to interpret. Jooble cannot run at all without
    // keywords, so this is where the two sources legitimately differ.
    expect(fetchImpl.mock.calls[0][0]).not.toContain("what=");
  });

  it("rejects a blank credential pair before any request is made", async () => {
    vi.stubEnv("ADZUNA_APP_ID", "");
    vi.stubEnv("ADZUNA_APP_KEY", "");
    const fetchImpl = fixtureFetch();

    await expect(
      adzunaIntakeAdapter.fetchLiveJobs({ limit: 20, country: "us" }, fetchImpl),
    ).rejects.toThrow(/app_id and app_key/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("adzunaIntakeAdapter — result shape", () => {
  it("maps the returned array into IntakeFetchResult", async () => {
    withCredentials();
    const fetchImpl = fixtureFetch();

    const result = await adzunaIntakeAdapter.fetchLiveJobs(
      { limit: 20, keywords: "Data Engineer", country: "gb" },
      fetchImpl,
    );

    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]).toMatchObject({
      sourceVacancyId: "4820001234",
      rawTitle: "Data Engineer",
      companyName: "Acme Corp",
    });
    expect(result.received).toBe(1);
  });

  it("reports received as the usable-listing count and skipped as 0", async () => {
    withCredentials();
    const fetchImpl = fixtureFetch();

    const result = await adzunaIntakeAdapter.fetchLiveJobs(
      { limit: 20, keywords: "Data Engineer", country: "gb" },
      fetchImpl,
    );

    // Same documented limitation as joobleIntake.ts: discoverAdzuna exposes
    // neither the raw count nor a skipped count, so 0 is reported rather than a
    // number that would have to be invented.
    expect(result.received).toBe(result.vacancies.length);
    expect(result.skipped).toBe(0);
  });

  it("returns an empty result rather than throwing when the source has no matches", async () => {
    withCredentials();
    const fetchImpl = fixtureFetch(200, { results: [] });

    const result = await adzunaIntakeAdapter.fetchLiveJobs({ limit: 20, country: "gb" }, fetchImpl);

    expect(result).toEqual({ vacancies: [], received: 0, skipped: 0 });
  });
});
