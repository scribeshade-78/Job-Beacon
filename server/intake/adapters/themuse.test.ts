import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchImpl } from "../../ingestion/types.js";
import {
  mapTheMuseJob,
  parseTheMusePublicationDate,
  parseTheMuseRemoteType,
  readTheMuseApiKey,
  theMuseIntakeAdapter,
  TheMusePayloadError,
  THE_MUSE_API_BASE,
} from "./themuse.js";

/** The shape confirmed against the live API, trimmed to what the adapter reads. */
const FIXTURE_JOB = {
  id: 19225596,
  short_name: "registered-nurse-6ec354",
  name: "Registered Nurse Med/Surg Telemetry",
  type: "external",
  model_type: "jobs",
  publication_date: "2025-06-10T09:59:33Z",
  locations: [{ name: "Dearborn, MI" }],
  categories: [{ name: "Data and Analytics" }],
  levels: [{ name: "Mid Level", short_name: "mid" }],
  refs: { landing_page: "https://www.themuse.com/jobs/dmcsinaigracehospital/registered-nurse-6ec354" },
  company: { id: 5012, short_name: "dmcsinaigracehospital", name: "DMC Sinai-Grace Hospital" },
  contents: "<p>Job description</p>",
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

function fixtureFetch(body: unknown, status = 200): FetchImpl {
  return vi.fn().mockResolvedValue(jsonResponse(status, body)) as unknown as FetchImpl;
}

/** The URL the adapter actually requested, as a string. */
function calledUrl(fetchImpl: FetchImpl): string {
  return String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseTheMusePublicationDate", () => {
  it("parses the API's ISO 8601 UTC format", () => {
    // Read from the RAW response body. An earlier version of this adapter used
    // "MM/DD/YYYY HH:mm:ss" and nulled every row, because that string was
    // PowerShell's rendering of an already-parsed DateTime rather than the bytes
    // on the wire.
    expect(parseTheMusePublicationDate("2025-06-10T09:59:33Z")).toBe("2025-06-10T09:59:33.000Z");
  });

  it("accepts an explicit UTC offset and fractional seconds", () => {
    expect(parseTheMusePublicationDate("2025-06-10T09:59:33.123Z")).toBe("2025-06-10T09:59:33.123Z");
    expect(parseTheMusePublicationDate("2025-06-10T09:59:33+05:30")).toBe("2025-06-10T04:29:33.000Z");
  });

  it("rejects the US-format string this adapter once wrongly accepted", () => {
    // Pinned so a regression to that misreading fails loudly instead of
    // silently nulling publishedAt on every row again.
    expect(parseTheMusePublicationDate("06/10/2025 09:59:33")).toBeNull();
  });

  it("returns null for an unparseable or absent value rather than inventing a date", () => {
    expect(parseTheMusePublicationDate("")).toBeNull();
    expect(parseTheMusePublicationDate("not a date")).toBeNull();
    expect(parseTheMusePublicationDate(undefined)).toBeNull();
    expect(parseTheMusePublicationDate(20250610)).toBeNull();
  });
});

describe("parseTheMuseRemoteType", () => {
  it("reads an explicit remote marker", () => {
    expect(parseTheMuseRemoteType(["Remote"])).toBe("remote");
    expect(parseTheMuseRemoteType(["Flexible / Remote"])).toBe("remote");
  });

  it("never infers a work arrangement from a bare place name", () => {
    // remote_type is filtered on, so guessing "on_site" here would be inventing
    // a fact The Muse never states.
    expect(parseTheMuseRemoteType(["Dearborn, MI"])).toBeNull();
    expect(parseTheMuseRemoteType(["London"])).toBeNull();
    expect(parseTheMuseRemoteType([])).toBeNull();
  });
});

describe("mapTheMuseJob", () => {
  it("maps the fields the payload actually carries", () => {
    const mapped = mapTheMuseJob(FIXTURE_JOB, "2025-01-01T00:00:00.000Z");

    expect(mapped).toMatchObject({
      sourceVacancyId: "19225596",
      authoritativeUrl: "https://www.themuse.com/jobs/dmcsinaigracehospital/registered-nurse-6ec354",
      rawTitle: "Registered Nurse Med/Surg Telemetry",
      companyName: "DMC Sinai-Grace Hospital",
      region: "Dearborn, MI",
      publishedAt: "2025-06-10T09:59:33.000Z",
    });
  });

  it("leaves country, city, domain and salary null rather than inferring them", () => {
    const mapped = mapTheMuseJob(FIXTURE_JOB, "2025-01-01T00:00:00.000Z");

    // "Dearborn, MI" is a city plus a state, not a country, and splitting it
    // would put a state code in the city column.
    expect(mapped).toMatchObject({
      country: null,
      city: null,
      companyDomain: null,
      currency: null,
      salaryMin: null,
      salaryMax: null,
      salarySource: null,
    });
  });

  it("preserves categories and levels in raw, where they are the only structured signal", () => {
    const mapped = mapTheMuseJob(FIXTURE_JOB, "2025-01-01T00:00:00.000Z") as unknown as {
      raw: { _intake: { source: string; museCategories: string[]; museLevels: string[] } };
    };

    expect(mapped.raw._intake.source).toBe("themuse");
    expect(mapped.raw._intake.museCategories).toEqual(["Data and Analytics"]);
    expect(mapped.raw._intake.museLevels).toEqual(["Mid Level"]);
  });

  it("skips a posting missing its landing page, id or company", () => {
    expect(mapTheMuseJob({ ...FIXTURE_JOB, refs: {} }, "t")).toBeNull();
    expect(mapTheMuseJob({ ...FIXTURE_JOB, id: undefined }, "t")).toBeNull();
    expect(mapTheMuseJob({ ...FIXTURE_JOB, company: {} }, "t")).toBeNull();
    expect(mapTheMuseJob({ ...FIXTURE_JOB, name: "  " }, "t")).toBeNull();
  });

  it("tolerates a missing locations array", () => {
    const mapped = mapTheMuseJob({ ...FIXTURE_JOB, locations: undefined }, "t");

    expect(mapped).toMatchObject({ region: null, remoteType: null });
  });
});

describe("readTheMuseApiKey", () => {
  it("is optional — an unauthenticated caller is legitimate", () => {
    expect(readTheMuseApiKey({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(readTheMuseApiKey({ THE_MUSE_API_KEY: "   " } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("trims a configured key", () => {
    expect(readTheMuseApiKey({ THE_MUSE_API_KEY: "  abc-123  " } as NodeJS.ProcessEnv)).toBe("abc-123");
  });
});

describe("theMuseIntakeAdapter.fetchLiveJobs", () => {
  const payload = { page: 0, page_count: 10, items_per_page: 20, total: 200, results: [FIXTURE_JOB] };

  it("requests page 0, because the API's pages are zero-based", async () => {
    const fetchImpl = fixtureFetch(payload);

    await theMuseIntakeAdapter.fetchLiveJobs({ limit: 20 }, fetchImpl);

    // page=1 would silently skip the newest twenty listings.
    expect(calledUrl(fetchImpl)).toContain("page=0");
    expect(calledUrl(fetchImpl)).toContain(THE_MUSE_API_BASE);
  });

  it("sends the candidate's location when there is one, and omits it when there is not", async () => {
    const withLocation = fixtureFetch(payload);
    await theMuseIntakeAdapter.fetchLiveJobs({ limit: 20, location: "Bengaluru, India" }, withLocation);
    // URLSearchParams form-encodes the space as "+", so normalise before comparing.
    expect(decodeURIComponent(calledUrl(withLocation)).replace(/\+/g, " ")).toContain("location=Bengaluru, India");

    const withoutLocation = fixtureFetch(payload);
    await theMuseIntakeAdapter.fetchLiveJobs({ limit: 20 }, withoutLocation);
    expect(calledUrl(withoutLocation)).not.toContain("location=");
  });

  it("adds api_key only when one is configured", async () => {
    vi.stubEnv("THE_MUSE_API_KEY", "key-abc");
    const withKey = fixtureFetch(payload);
    await theMuseIntakeAdapter.fetchLiveJobs({ limit: 20 }, withKey);
    expect(calledUrl(withKey)).toContain("api_key=key-abc");

    vi.unstubAllEnvs();
    const withoutKey = fixtureFetch(payload);
    await theMuseIntakeAdapter.fetchLiveJobs({ limit: 20 }, withoutKey);
    expect(calledUrl(withoutKey)).not.toContain("api_key=");
  });

  it("reports received and skipped honestly — The Muse gives the raw page", async () => {
    const fetchImpl = fixtureFetch({ ...payload, results: [FIXTURE_JOB, { ...FIXTURE_JOB, id: 2, refs: {} }] });

    const result = await theMuseIntakeAdapter.fetchLiveJobs({ limit: 20 }, fetchImpl);

    // Unlike Jooble and Adzuna, both counts are real here: `results` is the raw
    // page and the mapped null is the skipped entry.
    expect(result.received).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.vacancies).toHaveLength(1);
  });

  it("honours the caller's limit", async () => {
    const results = Array.from({ length: 5 }, (_, index) => ({ ...FIXTURE_JOB, id: index + 1 }));
    const fetchImpl = fixtureFetch({ ...payload, results });

    const result = await theMuseIntakeAdapter.fetchLiveJobs({ limit: 2 }, fetchImpl);

    expect(result.vacancies).toHaveLength(2);
    expect(result.received).toBe(5);
  });

  it("names the rate limit on a 403, since that is the documented status for it", async () => {
    const fetchImpl = fixtureFetch({}, 403);

    await expect(theMuseIntakeAdapter.fetchLiveJobs({ limit: 20 }, fetchImpl)).rejects.toThrow(/rate-limit/);
  });

  it("surfaces the API's own error text when it supplies one", async () => {
    const fetchImpl = fixtureFetch({ code: 400, error: "page must be an integer" }, 400);

    await expect(theMuseIntakeAdapter.fetchLiveJobs({ limit: 20 }, fetchImpl)).rejects.toThrow(
      /page must be an integer/,
    );
  });

  it("throws a payload error when the body is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
      headers: { get: () => null },
    } as unknown as Response) as unknown as FetchImpl;

    await expect(theMuseIntakeAdapter.fetchLiveJobs({ limit: 20 }, fetchImpl)).rejects.toBeInstanceOf(
      TheMusePayloadError,
    );
  });

  it("throws when the envelope has no results array", async () => {
    await expect(
      theMuseIntakeAdapter.fetchLiveJobs({ limit: 20 }, fixtureFetch({ page: 0 })),
    ).rejects.toBeInstanceOf(TheMusePayloadError);
  });

  it("returns an empty result rather than throwing when the source has no matches", async () => {
    // An empty page is a legitimate answer, not a failure — the contract
    // requires it not to throw.
    const result = await theMuseIntakeAdapter.fetchLiveJobs({ limit: 20 }, fixtureFetch({ ...payload, results: [] }));

    expect(result).toEqual({ vacancies: [], received: 0, skipped: 0 });
  });
});
