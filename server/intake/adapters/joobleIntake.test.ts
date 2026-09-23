import { afterEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import { joobleIntakeAdapter } from "./joobleIntake.js";

/**
 * The wrapper's own behavior: the two required-parameter throws, the delegation
 * into discoverJooble, and the IntakeFetchResult it returns.
 *
 * discoverJooble's internals (retries, paging, redaction, salary parsing) are
 * covered by server/ingestion/adapters/jooble.test.ts and deliberately not
 * re-tested here — this file only asserts the boundary this layer owns.
 *
 * fetchImpl is injected exactly as the ingestion adapter's own tests do.
 */

// Fixture shaped from Jooble's documented response (jobs[] + totalCount).
// `link` is the field normalizeJoobleJob treats as structural, so both entries
// carry one; the second is included to prove the array maps through whole.
const fixtureResponse = {
  totalCount: 2,
  jobs: [
    {
      id: 1001,
      title: "Data Engineer",
      location: "Bengaluru",
      company: "Acme",
      link: "https://jooble.org/jdp/1001",
      updated: "2026-09-15T12:55:35.3870000",
    },
    {
      id: 1002,
      title: "Analytics Engineer",
      location: "Remote",
      company: "Beta",
      link: "https://jooble.org/jdp/1002",
    },
  ],
};

/**
 * Typed as MockedFunction<typeof fetch> rather than cast to `typeof fetch`: the
 * cast would erase `.mock`, and these cases assert on the request body and on
 * the request COUNT, which is the whole point of the adapter.
 */
function fixtureFetch(status = 200, body: unknown = fixtureResponse): MockedFunction<typeof fetch> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as MockedFunction<typeof fetch>;
}

/** The JSON body of the first (in practice only) request. */
function sentBody(fetchImpl: MockedFunction<typeof fetch>): Record<string, string> {
  // `init` is optional on the fetch signature, so it is read defensively even
  // though this adapter always sends one — a missing init should fail the
  // assertion below rather than throw a TypeError.
  return JSON.parse((fetchImpl.mock.calls[0]?.[1]?.body ?? "{}") as string) as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("joobleIntakeAdapter — required parameters", () => {
  it("throws when keywords are missing, without making a request", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "test-jooble-key");
    const fetchImpl = fixtureFetch();

    await expect(
      joobleIntakeAdapter.fetchLiveJobs({ limit: 20, location: "Bengaluru" }, fetchImpl),
    ).rejects.toThrow(/requires keywords/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when the location is missing, without making a request", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "test-jooble-key");
    const fetchImpl = fixtureFetch();

    await expect(
      joobleIntakeAdapter.fetchLiveJobs({ limit: 20, keywords: "Data Engineer" }, fetchImpl),
    ).rejects.toThrow(/requires a location/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only keyword string as missing", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "test-jooble-key");
    const fetchImpl = fixtureFetch();

    await expect(
      joobleIntakeAdapter.fetchLiveJobs({ limit: 20, keywords: "   ", location: "Bengaluru" }, fetchImpl),
    ).rejects.toThrow(/requires keywords/);
  });

  it("names the source code the policy row must carry", () => {
    // Must match source_policies.source_code, or runIntake refuses the source
    // before fetchLiveJobs is ever reached.
    expect(joobleIntakeAdapter.sourceCode).toBe("jooble");
  });
});

describe("joobleIntakeAdapter — delegation", () => {
  it("sends one POST carrying the joined keywords and the location", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "test-jooble-key");
    const fetchImpl = fixtureFetch();

    await joobleIntakeAdapter.fetchLiveJobs(
      { limit: 20, keywords: "Data Engineer, Data Analyst", location: "Bengaluru" },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://jooble.org/api/test-jooble-key");
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(sentBody(fetchImpl)).toMatchObject({
      keywords: "Data Engineer, Data Analyst",
      location: "Bengaluru",
      page: "1",
    });
  });

  it("costs exactly ONE request per call, because the free plan is a lifetime quota", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "test-jooble-key");
    const fetchImpl = fixtureFetch();

    await joobleIntakeAdapter.fetchLiveJobs({ limit: 100, keywords: "Engineer", location: "London" }, fetchImpl);

    // maxPages is pinned to 1 and resultsPerPage carries the caller's limit, so
    // the page size is the only lever used. A second request here would be a
    // second request permanently spent.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchImpl).ResultOnPage).toBe("100");
  });

  it("does not forward a country preference, because Jooble's country is a property of the key", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "test-jooble-key");
    const fetchImpl = fixtureFetch();

    const result = await joobleIntakeAdapter.fetchLiveJobs(
      { limit: 20, keywords: "Engineer", location: "London", country: "in" },
      fetchImpl,
    );

    // A US-keyed run must not label its listings as Indian just because the
    // candidate prefers India — vacancies.country is filtered on elsewhere.
    expect(result.vacancies.every((vacancy) => vacancy.country === null)).toBe(true);
  });
});

describe("joobleIntakeAdapter — result shape", () => {
  it("maps the returned array into IntakeFetchResult", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "test-jooble-key");
    const fetchImpl = fixtureFetch();

    const result = await joobleIntakeAdapter.fetchLiveJobs(
      { limit: 20, keywords: "Data Engineer", location: "Bengaluru" },
      fetchImpl,
    );

    expect(result.vacancies).toHaveLength(2);
    expect(result.vacancies[0]).toMatchObject({
      sourceVacancyId: "1001",
      rawTitle: "Data Engineer",
      companyName: "Acme",
      // Jooble's payload has no country field, so it stays null rather than
      // being derived from the freeform location.
      country: null,
    });
    expect(result.received).toBe(2);
  });

  it("reports received as the usable-listing count and skipped as 0", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "test-jooble-key");
    const fetchImpl = fixtureFetch();

    const result = await joobleIntakeAdapter.fetchLiveJobs(
      { limit: 20, keywords: "Data Engineer", location: "Bengaluru" },
      fetchImpl,
    );

    // Documented limitation: discoverJooble exposes neither the raw pre-filter
    // count nor how many entries it dropped while normalizing, so these are
    // usable-listing counts and skipped is 0 rather than an invented figure.
    expect(result.received).toBe(result.vacancies.length);
    expect(result.skipped).toBe(0);
  });

  it("applies the caller's limit without misreporting what the source returned", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "test-jooble-key");
    const fetchImpl = fixtureFetch();

    const result = await joobleIntakeAdapter.fetchLiveJobs(
      { limit: 1, keywords: "Data Engineer", location: "Bengaluru" },
      fetchImpl,
    );

    expect(result.vacancies).toHaveLength(1);
    // received counts what came back, not what survived the slice.
    expect(result.received).toBe(2);
  });

  it("returns an empty result rather than throwing when the source has no matches", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "test-jooble-key");
    const fetchImpl = fixtureFetch(200, { totalCount: 0, jobs: [] });

    const result = await joobleIntakeAdapter.fetchLiveJobs(
      { limit: 20, keywords: "Nothing", location: "Nowhere" },
      fetchImpl,
    );

    // "No matches" must stay distinguishable from "the API is down".
    expect(result).toEqual({ vacancies: [], received: 0, skipped: 0 });
  });

  it("propagates a missing credential as a throw, so the fan-out records a skip", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "");
    const fetchImpl = fixtureFetch();

    await expect(
      joobleIntakeAdapter.fetchLiveJobs({ limit: 20, keywords: "Engineer", location: "London" }, fetchImpl),
    ).rejects.toThrow(/JOOBLE_API_KEY/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
