import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchImpl } from "../../ingestion/types.js";
import {
  mapSerpApiJob,
  parseSerpApiRemoteType,
  readSerpApiKey,
  serpapiIntakeAdapter,
  SerpApiPayloadError,
  SERPAPI_API_BASE,
} from "./serpapi.js";

/**
 * A real google_jobs row, captured from one live 200 and trimmed only in
 * `description`. Every field name and value here was read off the wire rather
 * than taken from documentation — including the ABSENCE of
 * `detected_extensions`, which the docs are widely described as sending and
 * which this payload does not contain.
 */
const FIXTURE_JOB = {
  title: "Senior Data Engineer (India - Remote)",
  company_name: "Anson McCade",
  location: "Vellore, Tamil Nadu",
  via: "BeBee",
  share_link:
    "https://www.google.com/search?ibp=htl;jobs&q=Data+Engineer&htidocid=BgN9UE1E1kmf5vS6AAAAAA%3D%3D&hl=en",
  source_link:
    "https://bebee.com/in/jobs/senior-data-engineer-india-remote-anson-mccade-vellore--talent-638681294404390648",
  job_title: "Senior Data Engineer (India - Remote)",
  job_id: "eyJqb2JfdGl0bGUiOiJTZW5pb3IgRGF0YSBFbmdpbmVlciAoSW5kaWEgLSBSZW1vdGUpIn0=",
  description: "Confidential opportunity with a global strategy firm.",
  extensions: ["2 days ago", "Internship"],
  apply_options: [
    {
      title: "BeBee",
      link: "https://bebee.com/in/jobs/senior-data-engineer-india-remote?utm_campaign=google_jobs_apply",
    },
    { title: "LinkedIn", link: "https://www.linkedin.com/jobs/view/123" },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function fixtureFetch(body: unknown, status = 200): FetchImpl {
  return vi.fn().mockResolvedValue(jsonResponse(status, body)) as unknown as FetchImpl;
}

function calledUrl(fetchImpl: FetchImpl): string {
  return String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
}

const PAYLOAD = { search_metadata: { status: "Success" }, jobs_results: [FIXTURE_JOB] };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseSerpApiRemoteType", () => {
  it("reads a remote marker from the TITLE, which is where this source puts it", () => {
    // The captured row's location is a bare "Vellore, Tamil Nadu"; the live
    // arrangement signal is in the title. A location-only rule (the Jooble one)
    // would have lost it.
    expect(parseSerpApiRemoteType(["Vellore, Tamil Nadu", "Senior Data Engineer (India - Remote)"])).toBe("remote");
  });

  it("reads a remote marker from location or extensions too", () => {
    expect(parseSerpApiRemoteType(["Remote"])).toBe("remote");
    expect(parseSerpApiRemoteType(["2 days ago", "Remote"])).toBe("remote");
  });

  it("never asserts a work arrangement the source did not state", () => {
    expect(parseSerpApiRemoteType(["Vellore, Tamil Nadu", "Internship"])).toBeNull();
    expect(parseSerpApiRemoteType([])).toBeNull();
    // "Hybrid" and "on-site" are never inferred, only "remote" is ever claimed.
    expect(parseSerpApiRemoteType(["Hybrid - Madison, WI"])).toBeNull();
  });
});

describe("mapSerpApiJob", () => {
  it("maps the fields the live payload actually carries", () => {
    const mapped = mapSerpApiJob(FIXTURE_JOB, "2026-01-01T00:00:00.000Z");

    expect(mapped).toMatchObject({
      sourceVacancyId: FIXTURE_JOB.job_id,
      authoritativeUrl: FIXTURE_JOB.share_link,
      rawTitle: "Senior Data Engineer (India - Remote)",
      companyName: "Anson McCade",
      region: "Vellore, Tamil Nadu",
      remoteType: "remote",
    });
  });

  it("leaves country, city, domain, salary AND publishedAt null", () => {
    const mapped = mapSerpApiJob(FIXTURE_JOB, "t");

    // publishedAt is null by construction: the only date-like value is the
    // relative string "2 days ago" in extensions, and no salary field is sent
    // at all.
    expect(mapped).toMatchObject({
      country: null,
      city: null,
      companyDomain: null,
      publishedAt: null,
      currency: null,
      salaryMin: null,
      salaryMax: null,
      salarySource: null,
    });
  });

  it("falls back to source_link when share_link is absent", () => {
    const mapped = mapSerpApiJob({ ...FIXTURE_JOB, share_link: undefined }, "t");

    expect(mapped?.authoritativeUrl).toBe(FIXTURE_JOB.source_link);
  });

  it("prefers share_link when both are present", () => {
    expect(mapSerpApiJob(FIXTURE_JOB, "t")?.authoritativeUrl).toBe(FIXTURE_JOB.share_link);
  });

  it("preserves via, extensions, apply_options and both links in raw._intake", () => {
    const mapped = mapSerpApiJob(FIXTURE_JOB, "2026-01-01T00:00:00.000Z") as unknown as {
      raw: {
        _intake: {
          source: string;
          via: string;
          extensions: string[];
          applyOptions: Array<{ title: string | null; link: string | null }>;
          sourceLink: string;
          shareLink: string;
        };
      };
    };

    const intake = mapped.raw._intake;
    expect(intake.source).toBe("serpapi");
    expect(intake.via).toBe("BeBee");
    expect(intake.extensions).toEqual(["2 days ago", "Internship"]);
    expect(intake.applyOptions).toHaveLength(2);
    expect(intake.applyOptions[0]?.title).toBe("BeBee");
    expect(intake.sourceLink).toBe(FIXTURE_JOB.source_link);
    expect(intake.shareLink).toBe(FIXTURE_JOB.share_link);
  });

  it("skips a posting with no usable url, no id or no company", () => {
    expect(mapSerpApiJob({ ...FIXTURE_JOB, share_link: undefined, source_link: undefined }, "t")).toBeNull();
    expect(mapSerpApiJob({ ...FIXTURE_JOB, job_id: undefined }, "t")).toBeNull();
    expect(mapSerpApiJob({ ...FIXTURE_JOB, company_name: "  " }, "t")).toBeNull();
    expect(mapSerpApiJob({ ...FIXTURE_JOB, title: undefined, job_title: undefined }, "t")).toBeNull();
  });

  it("tolerates a missing location and missing extensions", () => {
    const mapped = mapSerpApiJob(
      { ...FIXTURE_JOB, location: undefined, extensions: undefined, title: "Data Engineer" },
      "t",
    );

    expect(mapped).toMatchObject({ region: null, remoteType: null });
  });
});

describe("readSerpApiKey", () => {
  it("is mandatory — there is no unauthenticated tier", () => {
    expect(readSerpApiKey({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(readSerpApiKey({ SERPAPI_API_KEY: "   " } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("trims a configured key", () => {
    expect(readSerpApiKey({ SERPAPI_API_KEY: "  abc123  " } as NodeJS.ProcessEnv)).toBe("abc123");
  });
});

describe("serpapiIntakeAdapter.fetchLiveJobs", () => {
  it("refuses without a key, before any request is attempted", async () => {
    const fetchImpl = fixtureFetch(PAYLOAD);

    await expect(serpapiIntakeAdapter.fetchLiveJobs({ limit: 10 }, fetchImpl)).rejects.toThrow(
      /SERPAPI_API_KEY/,
    );
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("refuses without keywords, because google_jobs requires q", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "k");
    const fetchImpl = fixtureFetch(PAYLOAD);

    await expect(serpapiIntakeAdapter.fetchLiveJobs({ limit: 10 }, fetchImpl)).rejects.toThrow(/requires keywords/);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("issues ONE query carrying the combined roles, the location and the India-first defaults", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "k");
    const fetchImpl = fixtureFetch(PAYLOAD);

    await serpapiIntakeAdapter.fetchLiveJobs(
      { limit: 10, keywords: "Data Engineer, Data Analyst", location: "Bengaluru, India" },
      fetchImpl,
    );

    const url = decodeURIComponent(calledUrl(fetchImpl)).replace(/\+/g, " ");
    expect(calledUrl(fetchImpl)).toContain(SERPAPI_API_BASE);
    expect(url).toContain("engine=google_jobs");
    expect(url).toContain("q=Data Engineer, Data Analyst");
    expect(url).toContain("location=Bengaluru, India");
    expect(url).toContain("gl=in");
    expect(url).toContain("hl=en");
    // exactly one request per click — the quota rule
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("never sends a pagination parameter, which would cost a second search", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "k");
    const fetchImpl = fixtureFetch({ ...PAYLOAD, serpapi_pagination: { next_page_token: "tok" } });

    await serpapiIntakeAdapter.fetchLiveJobs({ limit: 10, keywords: "a" }, fetchImpl);

    const url = calledUrl(fetchImpl);
    expect(url).not.toContain("next_page_token");
    expect(url).not.toContain("start=");
  });

  it("omits location when the candidate has none", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "k");
    const fetchImpl = fixtureFetch(PAYLOAD);

    await serpapiIntakeAdapter.fetchLiveJobs({ limit: 10, keywords: "a" }, fetchImpl);

    expect(calledUrl(fetchImpl)).not.toContain("location=");
  });

  it("names an invalid key as invalid, and never leaks the credentialed URL", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "bad-key");
    const fetchImpl = fixtureFetch(
      { error: "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key" },
      401,
    );

    await expect(
      serpapiIntakeAdapter.fetchLiveJobs({ limit: 10, keywords: "a" }, fetchImpl),
    ).rejects.toThrow(/invalid/i);

    // THE KEY IS IN THE QUERY STRING, so a message containing the request URL
    // would contain the credential.
    await expect(
      serpapiIntakeAdapter.fetchLiveJobs({ limit: 10, keywords: "a" }, fixtureFetch({ error: "Invalid API key." }, 401)),
    ).rejects.not.toThrow(/api_key=bad-key/);
  });

  it("reports quota exhaustion distinctly from a bad key", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "k");
    const fetchImpl = fixtureFetch({ error: "Your account has run out of searches." }, 200);

    await expect(serpapiIntakeAdapter.fetchLiveJobs({ limit: 10, keywords: "a" }, fetchImpl)).rejects.toThrow(
      /quota exhausted/i,
    );
  });

  it("throws a payload error when the body is not JSON", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "k");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response) as unknown as FetchImpl;

    await expect(serpapiIntakeAdapter.fetchLiveJobs({ limit: 10, keywords: "a" }, fetchImpl)).rejects.toBeInstanceOf(
      SerpApiPayloadError,
    );
  });

  it("throws when the envelope has no jobs_results array", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "k");

    await expect(
      serpapiIntakeAdapter.fetchLiveJobs({ limit: 10, keywords: "a" }, fixtureFetch({ search_metadata: {} })),
    ).rejects.toBeInstanceOf(SerpApiPayloadError);
  });

  it("returns an empty result rather than throwing when Google has no matches", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "k");
    const fetchImpl = fixtureFetch({ ...PAYLOAD, jobs_results: [] });

    const result = await serpapiIntakeAdapter.fetchLiveJobs({ limit: 10, keywords: "a" }, fetchImpl);

    expect(result).toEqual({ vacancies: [], received: 0, skipped: 0 });
  });

  it("treats SerpApi's no-results ERROR STRING as an empty result, which is the shape production actually returns", async () => {
    // The empty-array case above is not what a zero-match google_jobs search
    // returns. It returns HTTP 200 with this error string and NO jobs_results key
    // at all, so before this was handled a successful-but-empty search was
    // written to source_health_events as status 'error' — and a production row
    // with exactly this message is what prompted the fix.
    vi.stubEnv("SERPAPI_API_KEY", "k");
    const fetchImpl = fixtureFetch({ error: "Google hasn't returned any results for this query." });

    const result = await serpapiIntakeAdapter.fetchLiveJobs({ limit: 10, keywords: "a" }, fetchImpl);

    expect(result).toEqual({ vacancies: [], received: 0, skipped: 0 });
  });

  it("still throws for an error string that is NOT a no-results message", async () => {
    // The guard against over-matching: an unrecognised error must stay an error
    // rather than being quietly reinterpreted as "no jobs found".
    vi.stubEnv("SERPAPI_API_KEY", "k");

    await expect(
      serpapiIntakeAdapter.fetchLiveJobs(
        { limit: 10, keywords: "a" },
        fixtureFetch({ error: "Something else went wrong entirely." }),
      ),
    ).rejects.toBeInstanceOf(SerpApiPayloadError);
  });

  it("reports received and skipped honestly, and slices to the caller's limit", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "k");
    const unmappable = { ...FIXTURE_JOB, job_id: undefined };
    const fetchImpl = fixtureFetch({ ...PAYLOAD, jobs_results: [FIXTURE_JOB, unmappable, FIXTURE_JOB] });

    const result = await serpapiIntakeAdapter.fetchLiveJobs({ limit: 1, keywords: "a" }, fetchImpl);

    expect(result.received).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.vacancies).toHaveLength(1);
  });
});
