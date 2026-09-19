import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverJooble,
  joobleAdapter,
  normalizeJoobleJob,
  parseJoobleRemoteType,
  parseJoobleSalary,
  readJoobleCredentials,
  redactJoobleEndpoint,
  REDACTED_JOOBLE_ENDPOINT,
} from "./jooble.js";

/**
 * Fixture shaped from the worked request/response example in Jooble's own
 * REST API documentation
 * (https://help.jooble.org/en/support/solutions/articles/60001448238-rest-api-documentation),
 * including the 7-fractional-digit `updated` value and the string-typed
 * request parameters that example uses. Verified against the doc, not invented.
 */
const fixtureJob = {
  id: 1234567890,
  title: "Sales Manager",
  location: "Kyiv",
  snippet: "This is a great opportunity to join our team...",
  salary: "17,600 UAH",
  source: "jooble",
  type: "Full-time",
  link: "https://ua.jooble.org/jdp/12345",
  company: "ABC Corp",
  updated: "2023-09-15T12:55:35.3870000",
};

const fixtureResponse = { totalCount: 1, jobs: [fixtureJob] };

interface MockResponseInit {
  status?: number;
  body?: unknown;
  retryAfter?: string | null;
  invalidJson?: boolean;
}

function mockResponse(init: MockResponseInit = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "retry-after" ? (init.retryAfter ?? null) : null,
    },
    json: async () => {
      if (init.invalidJson) {
        throw new SyntaxError("Unexpected token < in JSON");
      }
      return init.body ?? fixtureResponse;
    },
  };
}

function fixtureFetch(init: MockResponseInit = {}) {
  return vi.fn().mockResolvedValue(mockResponse(init)) as unknown as typeof fetch;
}

const credentials = { apiKey: "test-key-123" };
const searchConfig = { keywords: "Sales Manager", location: "Kyiv" };
/** Instant backoff so retry/pacing tests don't sleep for real. */
const fast = { minIntervalMs: 0, retryBaseDelayMs: 0 };

function callJsonBody(fetchImpl: typeof fetch, index = 0): Record<string, string> {
  const mock = fetchImpl as unknown as { mock: { calls: unknown[][] } };
  const [, init] = mock.mock.calls[index] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, string>;
}

function callUrl(fetchImpl: typeof fetch, index = 0): string {
  const mock = fetchImpl as unknown as { mock: { calls: unknown[][] } };
  return mock.mock.calls[index][0] as string;
}

function callCount(fetchImpl: typeof fetch): number {
  const mock = fetchImpl as unknown as { mock: { calls: unknown[][] } };
  return mock.mock.calls.length;
}

describe("readJoobleCredentials", () => {
  it("throws naming JOOBLE_API_KEY when unset, without echoing any value", () => {
    expect(() => readJoobleCredentials({} as NodeJS.ProcessEnv)).toThrow(/JOOBLE_API_KEY/);
  });

  it("throws when the variable is blank or whitespace", () => {
    expect(() => readJoobleCredentials({ JOOBLE_API_KEY: "" } as NodeJS.ProcessEnv)).toThrow(
      /JOOBLE_API_KEY/,
    );
    expect(() => readJoobleCredentials({ JOOBLE_API_KEY: "   " } as NodeJS.ProcessEnv)).toThrow(
      /JOOBLE_API_KEY/,
    );
  });

  it("rejects the .env.example placeholder rather than spending a request on it", () => {
    expect(() => readJoobleCredentials({ JOOBLE_API_KEY: "your_key_here" } as NodeJS.ProcessEnv)).toThrow(
      /placeholder/,
    );
  });

  it("returns the trimmed key for a real-looking value", () => {
    expect(readJoobleCredentials({ JOOBLE_API_KEY: "  abcd-1234  " } as NodeJS.ProcessEnv)).toEqual({
      apiKey: "abcd-1234",
    });
  });
});

describe("redactJoobleEndpoint", () => {
  it("replaces the credential path segment with the placeholder form", () => {
    expect(redactJoobleEndpoint("https://jooble.org/api/abcd-1234")).toBe(REDACTED_JOOBLE_ENDPOINT);
    expect(redactJoobleEndpoint("https://uk.jooble.org/api/abcd-1234?x=1")).toBe(
      "https://uk.jooble.org/api/{JOOBLE_API_KEY}",
    );
  });

  it("leaves unrelated URLs untouched", () => {
    const other = "https://api.adzuna.com/v1/api/jobs/gb/search/1";
    expect(redactJoobleEndpoint(other)).toBe(other);
  });

  it("redacts every occurrence in a multi-line message", () => {
    const message = "failed https://jooble.org/api/secret1 then https://jooble.org/api/secret2";
    const redacted = redactJoobleEndpoint(message);
    expect(redacted).not.toContain("secret1");
    expect(redacted).not.toContain("secret2");
  });
});

describe("parseJoobleSalary", () => {
  it("parses the documented single-value example", () => {
    expect(parseJoobleSalary("17,600 UAH")).toEqual({ min: 17600, max: 17600, currency: "UAH" });
  });

  it("parses a documented {min} - {max} {currency} range", () => {
    expect(parseJoobleSalary("5,000 - 7,000 EUR")).toEqual({ min: 5000, max: 7000, currency: "EUR" });
  });

  it("orders a reversed range by amount, not by print order", () => {
    expect(parseJoobleSalary("7,000 - 5,000 GBP")).toEqual({ min: 5000, max: 7000, currency: "GBP" });
  });

  it("handles dot-thousands and both-separator conventions", () => {
    expect(parseJoobleSalary("1.234.567 UAH")).toEqual({ min: 1234567, max: 1234567, currency: "UAH" });
    expect(parseJoobleSalary("1,234,567.89 USD")).toEqual({
      min: 1234567.89,
      max: 1234567.89,
      currency: "USD",
    });
    expect(parseJoobleSalary("1.234.567,89 EUR")).toEqual({
      min: 1234567.89,
      max: 1234567.89,
      currency: "EUR",
    });
  });

  it("does not mistake a word for a currency code", () => {
    expect(parseJoobleSalary("1,000 per month")).toEqual({ min: 1000, max: 1000, currency: null });
  });

  it("returns nulls for a non-numeric salary rather than guessing", () => {
    expect(parseJoobleSalary("Competitive")).toEqual({ min: null, max: null, currency: null });
    expect(parseJoobleSalary("")).toEqual({ min: null, max: null, currency: null });
    expect(parseJoobleSalary(null)).toEqual({ min: null, max: null, currency: null });
    expect(parseJoobleSalary(undefined)).toEqual({ min: null, max: null, currency: null });
  });
});

describe("normalizeJoobleJob", () => {
  it("maps the documented fixture into DiscoveredVacancy", () => {
    expect(normalizeJoobleJob(fixtureJob, "UA")).toEqual({
      sourceVacancyId: "1234567890",
      authoritativeUrl: "https://ua.jooble.org/jdp/12345",
      rawTitle: "Sales Manager",
      companyName: "ABC Corp",
      companyDomain: null,
      country: "UA",
      region: null,
      city: null,
      remoteType: null,
      currency: "UAH",
      salaryMin: 17600,
      salaryMax: 17600,
      salaryInterval: null,
      salarySource: "estimated",
      publishedAt: "2023-09-15T12:55:35.3870000",
      raw: fixtureJob,
    });
  });

  it("keeps the raw payload verbatim so snippet/type/source survive for JD extraction", () => {
    const normalized = normalizeJoobleJob(fixtureJob, null);
    expect(normalized?.raw).toBe(fixtureJob);
  });

  it("nulls country when target config supplies none", () => {
    expect(normalizeJoobleJob(fixtureJob, null)?.country).toBeNull();
  });

  it("falls back to Unknown company and Untitled title, and null salary", () => {
    const normalized = normalizeJoobleJob({ id: 5, link: "https://ua.jooble.org/jdp/5" }, "UA");
    expect(normalized?.companyName).toBe("Unknown");
    expect(normalized?.rawTitle).toBe("Untitled");
    expect(normalized?.salaryMin).toBeNull();
    expect(normalized?.salarySource).toBeNull();
    expect(normalized?.publishedAt).toBeNull();
  });

  it("rejects rows with no stable id or no destination link", () => {
    expect(normalizeJoobleJob({ link: "https://ua.jooble.org/jdp/1" }, null)).toBeNull();
    expect(normalizeJoobleJob({ id: 1 }, null)).toBeNull();
    expect(normalizeJoobleJob({ id: "", link: " " }, null)).toBeNull();
  });
});

describe("parseJoobleRemoteType (Mini-Phase 3)", () => {
  it("maps a location that mentions remote to 'remote'", () => {
    expect(parseJoobleRemoteType("Remote")).toBe("remote");
    expect(parseJoobleRemoteType("remote")).toBe("remote");
    expect(parseJoobleRemoteType("Fully Remote")).toBe("remote");
    expect(parseJoobleRemoteType("Remote - must live in NY")).toBe("remote");
  });

  it("leaves a plain place name null rather than inferring on_site", () => {
    // 38 of the 64 live Jooble vacancies carry a bare place name. 'on_site'
    // could only be inferred from "the location is a city", which asserts a
    // work arrangement Jooble never stated.
    expect(parseJoobleRemoteType("North Dakota")).toBeNull();
    expect(parseJoobleRemoteType("Chicago, IL")).toBeNull();
    expect(parseJoobleRemoteType("Kyiv")).toBeNull();
  });

  it("never produces 'hybrid' — no location value in the corpus says it", () => {
    expect(parseJoobleRemoteType("Hybrid - Madison, WI")).toBeNull();
  });

  it("treats a missing or non-string location as null", () => {
    expect(parseJoobleRemoteType(undefined)).toBeNull();
    expect(parseJoobleRemoteType(null)).toBeNull();
    expect(parseJoobleRemoteType(42)).toBeNull();
  });

  it("is wired into normalizeJoobleJob", () => {
    expect(normalizeJoobleJob({ ...fixtureJob, location: "Remote" }, "US")?.remoteType).toBe("remote");
    // The documented fixture's location is "Kyiv".
    expect(normalizeJoobleJob(fixtureJob, "UA")?.remoteType).toBeNull();
  });

  it("ignores the snippet even when the snippet says remote", () => {
    // The regression guard for the explicit product decision: 16 live rows
    // pair a place-name location with a truncated snippet that mentions
    // remote, and the snippet contradicts the location field in those cases.
    const contradictory = {
      ...fixtureJob,
      location: "North Dakota",
      snippet: "&nbsp;...Lead AiML <b>Engineer:</b> Remote Key Responsibilities ...&nbsp;",
    };

    expect(normalizeJoobleJob(contradictory, "US")?.remoteType).toBeNull();
  });
});

describe("discoverJooble", () => {
  it("throws a config-boundary error and never calls fetch when the key is missing", async () => {
    const fetchImpl = fixtureFetch();
    await expect(discoverJooble(searchConfig, { apiKey: "" }, fetchImpl)).rejects.toThrow(/API key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when keywords or location is missing, before spending a request", async () => {
    const fetchImpl = fixtureFetch();
    await expect(discoverJooble({ location: "Kyiv" }, credentials, fetchImpl)).rejects.toThrow(
      /keywords and location/,
    );
    await expect(discoverJooble({ keywords: "Sales" }, credentials, fetchImpl)).rejects.toThrow(
      /keywords and location/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs to the key-bearing endpoint with Jooble's documented string payload", async () => {
    const fetchImpl = fixtureFetch();
    await discoverJooble(
      { keywords: "Sales Manager, Administrator", location: "Kyiv", radius: "80", companySearch: false, ...fast },
      credentials,
      fetchImpl,
    );

    expect(callUrl(fetchImpl)).toBe("https://jooble.org/api/test-key-123");
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Accept: "application/json" });
    expect(callJsonBody(fetchImpl)).toEqual({
      keywords: "Sales Manager, Administrator",
      location: "Kyiv",
      page: "1",
      companysearch: "false",
      radius: "80",
      ResultOnPage: "100",
    });
  });

  it("normalizes the documented response", async () => {
    const result = await discoverJooble({ ...searchConfig, country: "ua", ...fast }, credentials, fixtureFetch());
    expect(result).toHaveLength(1);
    expect(result[0].sourceVacancyId).toBe("1234567890");
    expect(result[0].country).toBe("UA");
  });

  it("paginates until a short page, requesting page 2 with the same page size", async () => {
    // totalCount matches what the two pages yield, so this is a complete run.
    const page1 = { totalCount: 3, jobs: [fixtureJob, { ...fixtureJob, id: 2, link: "https://ua.jooble.org/jdp/2" }] };
    const page2 = { totalCount: 3, jobs: [{ ...fixtureJob, id: 3, link: "https://ua.jooble.org/jdp/3" }] };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ body: page1 }))
      .mockResolvedValueOnce(mockResponse({ body: page2 })) as unknown as typeof fetch;

    const result = await discoverJooble(
      { ...searchConfig, resultsPerPage: 2, maxPages: 5, ...fast },
      credentials,
      fetchImpl,
    );

    expect(callCount(fetchImpl)).toBe(2);
    expect(callJsonBody(fetchImpl, 1).page).toBe("2");
    expect(result.map((r) => r.sourceVacancyId)).toEqual(["1234567890", "2", "3"]);
  });

  it("stops as soon as totalCount is covered", async () => {
    const body = { totalCount: 1, jobs: [fixtureJob] };
    const fetchImpl = fixtureFetch({ body });
    await discoverJooble({ ...searchConfig, resultsPerPage: 1, maxPages: 5, ...fast }, credentials, fetchImpl);
    expect(callCount(fetchImpl)).toBe(1);
  });

  it("dedupes a job that appears on more than one page", async () => {
    // totalCount 2 = the two unique jobs actually available; the duplicate is
    // the same listing reappearing, not a missing one.
    const page = { totalCount: 2, jobs: [fixtureJob, { ...fixtureJob, id: 2, link: "https://ua.jooble.org/jdp/2" }] };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ body: page }))
      .mockResolvedValueOnce(mockResponse({ body: page })) as unknown as typeof fetch;

    const result = await discoverJooble(
      { ...searchConfig, resultsPerPage: 2, maxPages: 2, ...fast },
      credentials,
      fetchImpl,
    );

    expect(result.map((r) => r.sourceVacancyId)).toEqual(["1234567890", "2"]);
  });

  it("never exceeds maxRequestsPerRun and warns loudly about the partial result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Distinct ids per page — repeating one id would be deduped, not counted.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ body: { totalCount: 50, jobs: [fixtureJob] } }))
      .mockResolvedValueOnce(
        mockResponse({
          body: { totalCount: 50, jobs: [{ ...fixtureJob, id: 2, link: "https://ua.jooble.org/jdp/2" }] },
        }),
      ) as unknown as typeof fetch;

    const result = await discoverJooble(
      { ...searchConfig, resultsPerPage: 1, maxPages: 10, maxRequestsPerRun: 2, ...fast },
      credentials,
      fetchImpl,
    );

    expect(callCount(fetchImpl)).toBe(2);
    expect(result).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("partial discovery");
    expect(String(warn.mock.calls[0][0])).not.toContain("test-key-123");
    warn.mockRestore();
  });

  it("retries a transient 503 once, spending a second request", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 503 }))
      .mockResolvedValueOnce(mockResponse({ body: fixtureResponse })) as unknown as typeof fetch;

    const result = await discoverJooble({ ...searchConfig, ...fast }, credentials, fetchImpl);

    expect(callCount(fetchImpl)).toBe(2);
    expect(result).toHaveLength(1);
  });

  it("honours Retry-After on a 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 429, retryAfter: "0" }))
      .mockResolvedValueOnce(mockResponse({ body: fixtureResponse })) as unknown as typeof fetch;

    await discoverJooble({ ...searchConfig, ...fast }, credentials, fetchImpl);
    expect(callCount(fetchImpl)).toBe(2);
  });

  it("does NOT retry a 403 — one request, then a credential-shaped error", async () => {
    const fetchImpl = fixtureFetch({ status: 403 });
    await expect(discoverJooble({ ...searchConfig, ...fast }, credentials, fetchImpl)).rejects.toThrow(/403/);
    expect(callCount(fetchImpl)).toBe(1);
  });

  it("does NOT retry a 404 or an unlisted 4xx", async () => {
    const notFound = fixtureFetch({ status: 404 });
    await expect(discoverJooble({ ...searchConfig, ...fast }, credentials, notFound)).rejects.toThrow(/404/);
    expect(callCount(notFound)).toBe(1);

    const badRequest = fixtureFetch({ status: 400 });
    await expect(discoverJooble({ ...searchConfig, ...fast }, credentials, badRequest)).rejects.toThrow(/400/);
    expect(callCount(badRequest)).toBe(1);
  });

  it("surfaces an exhausted retry budget with the final status", async () => {
    const fetchImpl = fixtureFetch({ status: 500 });
    await expect(
      discoverJooble({ ...searchConfig, maxRetries: 1, ...fast }, credentials, fetchImpl),
    ).rejects.toThrow(/500/);
    expect(callCount(fetchImpl)).toBe(2);
  });

  it("retries a transport failure with a redacted message", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError("request to https://jooble.org/api/test-key-123 failed"),
      )
      .mockResolvedValueOnce(mockResponse({ body: fixtureResponse })) as unknown as typeof fetch;

    await discoverJooble({ ...searchConfig, ...fast }, credentials, fetchImpl);
    expect(callCount(fetchImpl)).toBe(2);
  });

  it("fails without retrying when a 200 body is not JSON", async () => {
    const fetchImpl = fixtureFetch({ invalidJson: true });
    await expect(discoverJooble({ ...searchConfig, ...fast }, credentials, fetchImpl)).rejects.toThrow(
      /not valid JSON/,
    );
    expect(callCount(fetchImpl)).toBe(1);
  });

  it("fails when the 200 body has no jobs array", async () => {
    const fetchImpl = fixtureFetch({ body: { totalCount: 0 } });
    await expect(discoverJooble({ ...searchConfig, ...fast }, credentials, fetchImpl)).rejects.toThrow(
      /jobs/,
    );
  });

  it("accepts an empty result set as a valid, non-error outcome", async () => {
    const fetchImpl = fixtureFetch({ body: { totalCount: 0, jobs: [] } });
    await expect(discoverJooble({ ...searchConfig, ...fast }, credentials, fetchImpl)).resolves.toEqual([]);
  });

  it("paces sequential page requests by at least minIntervalMs", async () => {
    // Two full pages of distinct jobs, totalCount exactly covering them, so
    // this exercises pacing without also being a truncated run.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          body: {
            totalCount: 4,
            jobs: [fixtureJob, { ...fixtureJob, id: 2, link: "https://ua.jooble.org/jdp/2" }],
          },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          body: {
            totalCount: 4,
            jobs: [
              { ...fixtureJob, id: 3, link: "https://ua.jooble.org/jdp/3" },
              { ...fixtureJob, id: 4, link: "https://ua.jooble.org/jdp/4" },
            ],
          },
        }),
      ) as unknown as typeof fetch;

    const startedAt = Date.now();
    await discoverJooble(
      { ...searchConfig, resultsPerPage: 2, maxPages: 2, minIntervalMs: 40, retryBaseDelayMs: 0 },
      credentials,
      fetchImpl,
    );
    const elapsed = Date.now() - startedAt;

    expect(callCount(fetchImpl)).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("SECURITY: no thrown error message ever contains the API key", async () => {
    const statuses = [400, 403, 404, 429, 500, 503];

    for (const status of statuses) {
      const fetchImpl = fixtureFetch({ status });
      let message = "";
      try {
        await discoverJooble(
          { ...searchConfig, maxRetries: 0, ...fast },
          credentials,
          fetchImpl,
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain("test-key-123");
      expect(message).not.toContain("jooble.org/api/test-key-123");
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

describe("joobleAdapter (registry wrapper)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("has the expected sourceCode", () => {
    expect(joobleAdapter.sourceCode).toBe("jooble");
  });

  it("validateConfig requires keywords, rejects bad radius, accepts a valid config", () => {
    expect(() => joobleAdapter.validateConfig({})).toThrow(/keywords/);
    expect(() => joobleAdapter.validateConfig({ keywords: "Sales" })).toThrow(/location/);
    expect(() =>
      joobleAdapter.validateConfig({ keywords: "Sales", location: "Kyiv", radius: "5" }),
    ).toThrow(/radius/);
    expect(() =>
      joobleAdapter.validateConfig({ keywords: "Sales", location: "Kyiv", radius: "80" }),
    ).not.toThrow();
    expect(() =>
      joobleAdapter.validateConfig({ keywords: "Sales", location: "Kyiv", resultsPerPage: "many" as never }),
    ).toThrow(/resultsPerPage/);
  });

  it("rejects a config error before any request is spent", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "env-key");
    const fetchImpl = fixtureFetch();
    await expect(joobleAdapter.discover("label", { location: "Kyiv" }, fetchImpl)).rejects.toThrow(
      /keywords/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads JOOBLE_API_KEY from process.env and delegates to discoverJooble", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "env-key");
    const fetchImpl = fixtureFetch();

    await joobleAdapter.discover("label", { ...searchConfig, ...fast }, fetchImpl);

    expect(callUrl(fetchImpl)).toBe("https://jooble.org/api/env-key");
    expect(callCount(fetchImpl)).toBe(1);
  });

  it("throws when the env credential is missing", async () => {
    vi.stubEnv("JOOBLE_API_KEY", "");
    const fetchImpl = fixtureFetch();
    await expect(joobleAdapter.discover("label", { ...searchConfig, ...fast }, fetchImpl)).rejects.toThrow(
      /JOOBLE_API_KEY/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
