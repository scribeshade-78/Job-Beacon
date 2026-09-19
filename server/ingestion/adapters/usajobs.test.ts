import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverUsajobs, parseUsajobsRemoteType, usajobsAdapter } from "./usajobs.js";

// Fixture shaped from the corroborated (not primary-source-verified, see
// the adapter's verification note) SearchResult.SearchResultItems[].
// MatchedObjectDescriptor structure.
const fixtureResponse = {
  SearchResult: {
    SearchResultItems: [
      {
        MatchedObjectDescriptor: {
          PositionID: "ABC-2026-0001",
          PositionTitle: "IT SPECIALIST (INFOSEC/NETWORK)",
          PositionURI: "https://www.usajobs.gov/job/123456700",
          OrganizationName: "Department of Example",
          PositionLocationDisplay: "Washington, DC",
          PublicationStartDate: "2026-08-01",
          PositionRemuneration: [
            { MinimumRange: "95000", MaximumRange: "120000", RateIntervalCode: "Per Year" },
          ],
        },
      },
    ],
  },
};

function fixtureFetch(status = 200, body: unknown = fixtureResponse) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

const credentials = { apiKey: "test-key", userAgent: "test@example.com" };

describe("discoverUsajobs", () => {
  it("throws a config-boundary error and never calls fetch when credentials are missing", async () => {
    const fetchImpl = fixtureFetch();

    await expect(
      discoverUsajobs({ keyword: "engineer" }, { apiKey: "", userAgent: "" }, fetchImpl),
    ).rejects.toThrow(/Authorization-Key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the correct headers (Host, User-Agent as registered email, Authorization-Key)", async () => {
    const fetchImpl = fixtureFetch();

    await discoverUsajobs({ keyword: "engineer" }, credentials, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://data.usajobs.gov/api/search?Keyword=engineer",
      {
        headers: {
          Host: "data.usajobs.gov",
          "User-Agent": "test@example.com",
          "Authorization-Key": "test-key",
        },
      },
    );
  });

  it("normalizes search results into DiscoveredVacancy shape", async () => {
    const result = await discoverUsajobs({ keyword: "engineer" }, credentials, fixtureFetch());

    expect(result[0]).toEqual({
      sourceVacancyId: "ABC-2026-0001",
      authoritativeUrl: "https://www.usajobs.gov/job/123456700",
      rawTitle: "IT SPECIALIST (INFOSEC/NETWORK)",
      companyName: "Department of Example",
      companyDomain: null,
      country: "US",
      region: null,
      city: null,
      remoteType: null,
      currency: "USD",
      salaryMin: 95000,
      salaryMax: 120000,
      salaryInterval: "year",
      salarySource: "employer_disclosed",
      publishedAt: "2026-08-01",
      raw: fixtureResponse.SearchResult.SearchResultItems[0].MatchedObjectDescriptor,
    });
  });

  it("maps RemoteIndicator true to 'remote' and leaves false/absent null", async () => {
    const withIndicator = (remoteIndicator: boolean | undefined) => ({
      SearchResult: {
        SearchResultItems: [
          {
            MatchedObjectDescriptor: {
              PositionID: "ABC-2026-0002",
              PositionTitle: "IT SPECIALIST",
              PositionURI: "https://www.usajobs.gov/job/123456701",
              UserArea: { Details: remoteIndicator === undefined ? {} : { RemoteIndicator: remoteIndicator } },
            },
          },
        ],
      },
    });

    const remote = await discoverUsajobs({}, credentials, fixtureFetch(200, withIndicator(true)));
    const notRemote = await discoverUsajobs({}, credentials, fixtureFetch(200, withIndicator(false)));
    const unspecified = await discoverUsajobs({}, credentials, fixtureFetch(200, withIndicator(undefined)));

    expect(remote[0].remoteType).toBe("remote");
    // false is "unspecified", not an explicit denial — mapping it to 'on_site'
    // would assert a work arrangement the posting never claimed.
    expect(notRemote[0].remoteType).toBeNull();
    expect(unspecified[0].remoteType).toBeNull();
  });

  it("defaults companyName when OrganizationName is absent", async () => {
    const result = await discoverUsajobs(
      {},
      credentials,
      fixtureFetch(200, {
        SearchResult: {
          SearchResultItems: [
            { MatchedObjectDescriptor: { PositionID: "X-1", PositionTitle: "Analyst", PositionURI: "https://usajobs.gov/job/x1" } },
          ],
        },
      }),
    );

    expect(result[0].companyName).toBe("U.S. Government");
    expect(result[0].salaryMin).toBeNull();
    expect(result[0].currency).toBeNull();
  });

  it("throws a clear error on a non-2xx response", async () => {
    await expect(
      discoverUsajobs({}, credentials, fixtureFetch(500, {})),
    ).rejects.toThrow(/500/);
  });
});

describe("parseUsajobsRemoteType (Mini-Phase 3)", () => {
  it("maps only a literal true to 'remote'", () => {
    expect(parseUsajobsRemoteType(true)).toBe("remote");
  });

  it("treats false as unspecified rather than as an explicit on_site", () => {
    // All 25 live USAJOBS payloads currently carry false; a government
    // dataset normally leaves a boolean unchecked rather than denying it.
    expect(parseUsajobsRemoteType(false)).toBeNull();
  });

  it("treats absent or non-boolean values as null", () => {
    expect(parseUsajobsRemoteType(undefined)).toBeNull();
    expect(parseUsajobsRemoteType(null)).toBeNull();
    expect(parseUsajobsRemoteType("true")).toBeNull();
  });

  it("never produces 'hybrid' or 'on_site'", () => {
    expect(parseUsajobsRemoteType(false)).not.toBe("on_site");
    expect(parseUsajobsRemoteType(true)).not.toBe("hybrid");
  });
});

describe("usajobsAdapter (MP-A2.1 registry wrapper)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("has the expected sourceCode", () => {
    expect(usajobsAdapter.sourceCode).toBe("usajobs");
  });

  it("validateConfig accepts any config — no required target-level fields", () => {
    expect(() => usajobsAdapter.validateConfig({})).not.toThrow();
    expect(() => usajobsAdapter.validateConfig({ keyword: "engineer" })).not.toThrow();
  });

  it("reads credentials from process.env and delegates to discoverUsajobs", async () => {
    vi.stubEnv("USAJOBS_API_KEY", "env-key");
    vi.stubEnv("USAJOBS_USER_AGENT", "env@example.com");
    const fetchImpl = fixtureFetch();

    await usajobsAdapter.discover("saved-search-label", { keyword: "engineer" }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://data.usajobs.gov/api/search?Keyword=engineer",
      {
        headers: {
          Host: "data.usajobs.gov",
          "User-Agent": "env@example.com",
          "Authorization-Key": "env-key",
        },
      },
    );
  });

  it("throws when env credentials are missing — same behavior as before this phase", async () => {
    vi.stubEnv("USAJOBS_API_KEY", "");
    vi.stubEnv("USAJOBS_USER_AGENT", "");
    const fetchImpl = fixtureFetch();

    await expect(usajobsAdapter.discover("saved-search-label", { keyword: "engineer" }, fetchImpl)).rejects.toThrow(
      /Authorization-Key/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
