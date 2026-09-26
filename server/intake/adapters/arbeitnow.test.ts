import { describe, expect, it, vi } from "vitest";
import type { FetchImpl } from "../../ingestion/types.js";
import {
  arbeitnowIntakeAdapter,
  ArbeitnowPayloadError,
  mapArbeitnowJob,
  matchesSelectedRoles,
  parseArbeitnowCreatedAt,
  ARBEITNOW_API_BASE,
} from "./arbeitnow.js";

/**
 * A real Arbeitnow posting, captured from one live 200 and trimmed only in
 * `description`. Note `created_at` is the Int64 1790445314 — epoch SECONDS —
 * and `remote` is a real boolean, both read off the wire rather than recalled.
 */
const FIXTURE_JOB = {
  slug: "working-student-b2c-channels-eu-dutch-market-berlin-berlin-505",
  company_name: "raisin",
  title: "Working Student B2C Channels EU (m/f/d) – Dutch Market",
  description: "&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;Join our team&lt;/p&gt;&lt;/div&gt;",
  remote: false,
  url: "https://www.arbeitnow.com/jobs/companies/raisin/working-student-b2c-channels-eu-dutch-market-berlin-berlin-505",
  tags: ["B2C Channels EU"],
  job_types: [] as string[],
  location: "Berlin, Berlin",
  created_at: 1790445314,
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

const PAYLOAD = { data: [FIXTURE_JOB], links: { next: `${ARBEITNOW_API_BASE}?page=2` }, meta: { per_page: 286 } };

describe("parseArbeitnowCreatedAt", () => {
  it("reads the value as epoch SECONDS, not milliseconds", () => {
    // The whole point: 1790445314 seconds lands in 2026. Read as milliseconds it
    // would be January 1970 — a silently wrong date on every row.
    expect(parseArbeitnowCreatedAt(1790445314)).toMatch(/^2026-/);
  });

  it("rejects a value that is already in milliseconds rather than returning a year-58000 date", () => {
    // Guards a future unit change: 1790445314000 * 1000 is still a VALID Date,
    // so without the year window this would silently become a nonsense
    // timestamp instead of failing.
    expect(parseArbeitnowCreatedAt(1790445314000)).toBeNull();
  });

  it("returns null for a string, zero, negative or missing value", () => {
    expect(parseArbeitnowCreatedAt("1790445314")).toBeNull();
    expect(parseArbeitnowCreatedAt(0)).toBeNull();
    expect(parseArbeitnowCreatedAt(-1)).toBeNull();
    expect(parseArbeitnowCreatedAt(undefined)).toBeNull();
    expect(parseArbeitnowCreatedAt(null)).toBeNull();
  });
});

describe("matchesSelectedRoles", () => {
  it("matches against the title", () => {
    expect(matchesSelectedRoles("Senior Data Engineer", [], "data engineer")).toBe(true);
  });

  it("matches against a tag", () => {
    expect(matchesSelectedRoles("Working Student", ["B2C Channels EU"], "b2c channels")).toBe(true);
  });

  it("is case-insensitive and substring-based, like eligibilityGate's role_match", () => {
    expect(matchesSelectedRoles("Senior DATA Engineer", [], "data")).toBe(true);
  });

  it("matches any one of several comma-joined roles", () => {
    expect(matchesSelectedRoles("Product Designer", [], "data engineer, product designer")).toBe(true);
  });

  it("treats blank or absent keywords as NO filter, not as match-nothing", () => {
    // A candidate with no selected roles still gets the newest postings — the
    // same answer Remotive gives when it sends no search term.
    expect(matchesSelectedRoles("Anything At All", [], undefined)).toBe(true);
    expect(matchesSelectedRoles("Anything At All", [], "")).toBe(true);
    expect(matchesSelectedRoles("Anything At All", [], "  ,  ")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(matchesSelectedRoles("Working Student", ["B2C Channels EU"], "data engineer")).toBe(false);
  });
});

describe("mapArbeitnowJob", () => {
  it("maps the fields the live payload actually carries", () => {
    const mapped = mapArbeitnowJob(FIXTURE_JOB, "2026-01-01T00:00:00.000Z");

    expect(mapped).toMatchObject({
      sourceVacancyId: FIXTURE_JOB.slug,
      authoritativeUrl: FIXTURE_JOB.url,
      rawTitle: FIXTURE_JOB.title,
      companyName: "raisin",
      region: "Berlin, Berlin",
      publishedAt: new Date(1790445314 * 1000).toISOString(),
    });
  });

  it("maps remote TRUE to remote, and remote FALSE to null rather than on_site", () => {
    // "Not remote" does not distinguish on-site from hybrid, and remote_type is
    // filtered on, so only the claim the source made is carried.
    expect(mapArbeitnowJob({ ...FIXTURE_JOB, remote: true }, "t")?.remoteType).toBe("remote");
    expect(mapArbeitnowJob({ ...FIXTURE_JOB, remote: false }, "t")?.remoteType).toBeNull();
    expect(mapArbeitnowJob({ ...FIXTURE_JOB, remote: undefined }, "t")?.remoteType).toBeNull();
  });

  it("leaves country, city, domain and salary null", () => {
    expect(mapArbeitnowJob(FIXTURE_JOB, "t")).toMatchObject({
      country: null,
      city: null,
      companyDomain: null,
      currency: null,
      salaryMin: null,
      salaryMax: null,
      salarySource: null,
    });
  });

  it("preserves tags and job_types in raw._intake and keeps the escaped description verbatim", () => {
    const mapped = mapArbeitnowJob(FIXTURE_JOB, "2026-01-01T00:00:00.000Z") as unknown as {
      raw: { description: string; _intake: { source: string; tags: string[]; jobTypes: string[] } };
    };

    expect(mapped.raw._intake.source).toBe("arbeitnow");
    expect(mapped.raw._intake.tags).toEqual(["B2C Channels EU"]);
    expect(mapped.raw._intake.jobTypes).toEqual([]);
    // Arrives HTML-escaped; preserved as sent, not silently unescaped.
    expect(mapped.raw.description).toContain("&lt;div");
  });

  it("skips a posting missing its slug, url, title or company", () => {
    expect(mapArbeitnowJob({ ...FIXTURE_JOB, slug: "" }, "t")).toBeNull();
    expect(mapArbeitnowJob({ ...FIXTURE_JOB, url: undefined }, "t")).toBeNull();
    expect(mapArbeitnowJob({ ...FIXTURE_JOB, title: "  " }, "t")).toBeNull();
    expect(mapArbeitnowJob({ ...FIXTURE_JOB, company_name: undefined }, "t")).toBeNull();
  });

  it("tolerates missing tags, job_types and location", () => {
    const mapped = mapArbeitnowJob(
      { ...FIXTURE_JOB, tags: undefined, job_types: undefined, location: undefined },
      "t",
    );

    expect(mapped).toMatchObject({ region: null });
    expect((mapped?.raw as { _intake: { tags: string[] } })._intake.tags).toEqual([]);
  });
});

describe("arbeitnowIntakeAdapter.fetchLiveJobs", () => {
  it("GETs the base endpoint with no query parameters at all", async () => {
    const fetchImpl = fixtureFetch(PAYLOAD);

    await arbeitnowIntakeAdapter.fetchLiveJobs({ limit: 50 }, fetchImpl);

    expect(calledUrl(fetchImpl)).toBe(ARBEITNOW_API_BASE);
    // one request per click — pagination is deliberately not followed
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("does not follow links.next even when the payload offers one", async () => {
    const fetchImpl = fixtureFetch(PAYLOAD);

    await arbeitnowIntakeAdapter.fetchLiveJobs({ limit: 50 }, fetchImpl);

    expect(calledUrl(fetchImpl)).not.toContain("page=");
  });

  it("filters locally on the selected roles, matching a title or a tag", async () => {
    // The fixture's title is "Working Student B2C Channels EU (m/f/d) – Dutch
    // Market" and its only tag is "B2C Channels EU", so neither a title word nor
    // a tag word is a coincidental match.
    const byTitle = await arbeitnowIntakeAdapter.fetchLiveJobs(
      { limit: 50, keywords: "working student" },
      fixtureFetch(PAYLOAD),
    );
    const byTag = await arbeitnowIntakeAdapter.fetchLiveJobs(
      { limit: 50, keywords: "b2c channels" },
      fixtureFetch(PAYLOAD),
    );
    const noMatch = await arbeitnowIntakeAdapter.fetchLiveJobs(
      { limit: 50, keywords: "plumber" },
      fixtureFetch(PAYLOAD),
    );

    expect(byTitle.vacancies).toHaveLength(1);
    expect(byTag.vacancies).toHaveLength(1);
    expect(noMatch.vacancies).toHaveLength(0);
  });

  it("returns the newest postings unfiltered when no roles are selected", async () => {
    const fetchImpl = fixtureFetch(PAYLOAD);

    const result = await arbeitnowIntakeAdapter.fetchLiveJobs({ limit: 50 }, fetchImpl);

    expect(result.vacancies).toHaveLength(1);
  });

  it("keeps `skipped` for unmappable rows only, not for role misses", async () => {
    // A posting that did not match the roles was read and understood; folding it
    // into `skipped` would conflate "not for you" with "unparseable".
    const unmappable = { ...FIXTURE_JOB, slug: undefined };
    const fetchImpl = fixtureFetch({ ...PAYLOAD, data: [FIXTURE_JOB, unmappable] });

    const result = await arbeitnowIntakeAdapter.fetchLiveJobs({ limit: 50, keywords: "plumber" }, fetchImpl);

    expect(result.received).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.vacancies).toHaveLength(0);
  });

  it("honours the caller's limit after filtering", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ ...FIXTURE_JOB, slug: `slug-${i}` }));
    const fetchImpl = fixtureFetch({ ...PAYLOAD, data: rows });

    const result = await arbeitnowIntakeAdapter.fetchLiveJobs({ limit: 2 }, fetchImpl);

    expect(result.vacancies).toHaveLength(2);
    expect(result.received).toBe(5);
  });

  it("returns an empty result rather than throwing when the board has no jobs", async () => {
    const result = await arbeitnowIntakeAdapter.fetchLiveJobs({ limit: 50 }, fixtureFetch({ ...PAYLOAD, data: [] }));

    expect(result).toEqual({ vacancies: [], received: 0, skipped: 0 });
  });

  it("throws a payload error on a non-2xx", async () => {
    await expect(
      arbeitnowIntakeAdapter.fetchLiveJobs({ limit: 50 }, fixtureFetch({}, 503)),
    ).rejects.toBeInstanceOf(ArbeitnowPayloadError);
  });

  it("throws when the body is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response) as unknown as FetchImpl;

    await expect(arbeitnowIntakeAdapter.fetchLiveJobs({ limit: 50 }, fetchImpl)).rejects.toBeInstanceOf(
      ArbeitnowPayloadError,
    );
  });

  it("throws when the envelope has no data array", async () => {
    await expect(
      arbeitnowIntakeAdapter.fetchLiveJobs({ limit: 50 }, fixtureFetch({ meta: {} })),
    ).rejects.toBeInstanceOf(ArbeitnowPayloadError);
  });
});
