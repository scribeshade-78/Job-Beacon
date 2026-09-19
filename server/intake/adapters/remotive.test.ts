import { describe, expect, it, vi } from "vitest";
import {
  mapRemotiveJob,
  REMOTIVE_API_BASE,
  remotiveIntakeAdapter,
  RemotivePayloadError,
} from "./remotive.js";

const FETCHED_AT = "2026-09-18T20:00:00.000Z";

/** A real-shaped Remotive posting, field for field. */
function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 2091129,
    url: "https://remotive.com/remote-jobs/data/senior-data-scientist-2091129",
    title: "Senior Data Scientist",
    company_name: "Lemon.io",
    category: "Data and Analytics",
    tags: ["Data Scientist"],
    job_type: "full_time",
    publication_date: "2026-09-16T12:35:28",
    candidate_required_location: "Northern America, LATAM, Europe, APAC",
    salary: "$170k - $200k",
    description: "<p>...</p>",
    company_logo: "https://remotive.com/job/2091129/logo",
    ...overrides,
  };
}

describe("mapRemotiveJob", () => {
  it("maps the fields it can honestly map", () => {
    const mapped = mapRemotiveJob(job(), FETCHED_AT);

    expect(mapped).toMatchObject({
      sourceVacancyId: "2091129",
      rawTitle: "Senior Data Scientist",
      companyName: "Lemon.io",
      publishedAt: "2026-09-16T12:35:28",
      remoteType: "remote",
    });
  });

  it("uses Remotive's own URL as the authoritative URL — the link-back its terms require", () => {
    const mapped = mapRemotiveJob(job(), FETCHED_AT);

    expect(mapped?.authoritativeUrl).toBe(
      "https://remotive.com/remote-jobs/data/senior-data-scientist-2091129",
    );
    expect(mapped?.authoritativeUrl.startsWith("https://remotive.com/")).toBe(true);
  });

  it("carries the required-location text verbatim in region and invents no country", () => {
    // "Northern America, LATAM, Europe, APAC" is not a country. Putting it in
    // country would be a fabricated fact in a column other code filters on.
    const mapped = mapRemotiveJob(
      job({ candidate_required_location: "Northern America, LATAM, Europe, APAC" }),
      FETCHED_AT,
    );

    expect(mapped?.region).toBe("Northern America, LATAM, Europe, APAC");
    expect(mapped?.country).toBeNull();
    expect(mapped?.city).toBeNull();
  });

  it("refuses to parse a salary string into numbers", () => {
    // The real values include "$31,2k- $52k" (decimal or thousands comma?),
    // "OTE $25k - $35k" (on-target earnings, not base) and "$10K-$20K" with no
    // interval. Any number produced from those would be a guess.
    for (const salary of ["$170k - $200k", "$31,2k- $52k", "OTE $25k - $35k", "$10K-$20K", "$14/hour"]) {
      const mapped = mapRemotiveJob(job({ salary }), FETCHED_AT);

      expect(mapped?.salaryMin).toBeNull();
      expect(mapped?.salaryMax).toBeNull();
      expect(mapped?.salaryInterval).toBeNull();
      expect(mapped?.currency).toBeNull();
      expect(mapped?.salarySource).toBeNull();
      // ...but the raw string is preserved, so nothing is lost.
      expect((mapped?.raw as { salary: string }).salary).toBe(salary);
    }
  });

  it("does not derive a company domain from the company name", () => {
    const mapped = mapRemotiveJob(job(), FETCHED_AT);

    expect(mapped?.companyDomain).toBeNull();
    expect((mapped?.raw as { company_logo?: string }).company_logo).toContain("remotive.com");
  });

  it("stamps the raw payload with which reading of the terms it was ingested under", () => {
    const mapped = mapRemotiveJob(job(), FETCHED_AT);

    expect((mapped?.raw as { _intake: unknown })._intake).toEqual({
      source: "remotive",
      noticeVersion: "remotive-api-notice-v1",
      fetchedAt: FETCHED_AT,
    });
  });

  it("keeps the whole original posting, including fields with no column", () => {
    const mapped = mapRemotiveJob(job(), FETCHED_AT);

    expect(mapped?.raw).toMatchObject({
      category: "Data and Analytics",
      job_type: "full_time",
      tags: ["Data Scientist"],
    });
  });

  it.each([
    ["id", { id: undefined }],
    ["url", { url: "" }],
    ["title", { title: null }],
    ["company_name", { company_name: "   " }],
  ])("returns null for a listing with no usable %s", (_field, override) => {
    expect(mapRemotiveJob(job(override), FETCHED_AT)).toBeNull();
  });

  it("accepts a string id, because the adapter should not fail on a type the source may change", () => {
    expect(mapRemotiveJob(job({ id: "2091129" }), FETCHED_AT)?.sourceVacancyId).toBe("2091129");
  });
});

function jsonFetch(payload: unknown, status = 200) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

describe("remotiveIntakeAdapter.fetchLiveJobs", () => {
  it("passes the search term and the limit to the source", async () => {
    const { fetchImpl, calls } = jsonFetch({ jobs: [] });

    await remotiveIntakeAdapter.fetchLiveJobs({ search: "data engineer", limit: 5 }, fetchImpl);

    expect(calls[0].startsWith(REMOTIVE_API_BASE)).toBe(true);
    expect(calls[0]).toContain("search=data+engineer");
    expect(calls[0]).toContain("limit=5");
  });

  it("omits the search parameter when no query was given, rather than sending an empty one", async () => {
    const { fetchImpl, calls } = jsonFetch({ jobs: [] });

    await remotiveIntakeAdapter.fetchLiveJobs({ limit: 5 }, fetchImpl);

    expect(calls[0]).not.toContain("search=");
  });

  it("enforces the caller's limit even when the source returns more", async () => {
    const { fetchImpl } = jsonFetch({
      jobs: Array.from({ length: 12 }, (_, index) => job({ id: 1000 + index })),
    });

    const result = await remotiveIntakeAdapter.fetchLiveJobs({ limit: 4 }, fetchImpl);

    expect(result.vacancies).toHaveLength(4);
    expect(result.received).toBe(12);
  });

  it("reports how many listings it could not use, instead of hiding the drop", async () => {
    const { fetchImpl } = jsonFetch({
      jobs: [job({ id: 1 }), job({ id: undefined }), job({ id: 3, url: null })],
    });

    const result = await remotiveIntakeAdapter.fetchLiveJobs({ limit: 10 }, fetchImpl);

    expect(result.vacancies).toHaveLength(1);
    expect(result.received).toBe(3);
    expect(result.skipped).toBe(2);
  });

  it("treats an empty result as an answer, not a failure", async () => {
    const { fetchImpl } = jsonFetch({ jobs: [] });

    await expect(remotiveIntakeAdapter.fetchLiveJobs({ limit: 10 }, fetchImpl)).resolves.toEqual({
      vacancies: [],
      received: 0,
      skipped: 0,
    });
  });

  it("throws a named error on an HTTP failure", async () => {
    const { fetchImpl } = jsonFetch({}, 503);

    await expect(remotiveIntakeAdapter.fetchLiveJobs({ limit: 1 }, fetchImpl)).rejects.toBeInstanceOf(
      RemotivePayloadError,
    );
  });

  it("throws a named error when the body is not JSON", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token <");
      },
    })) as unknown as typeof fetch;

    await expect(remotiveIntakeAdapter.fetchLiveJobs({ limit: 1 }, fetchImpl)).rejects.toBeInstanceOf(
      RemotivePayloadError,
    );
  });

  it("throws a named error when the payload has no jobs array", async () => {
    const { fetchImpl } = jsonFetch({ "00-warning": "moved domains" });

    await expect(remotiveIntakeAdapter.fetchLiveJobs({ limit: 1 }, fetchImpl)).rejects.toBeInstanceOf(
      RemotivePayloadError,
    );
  });

  it("declares its attribution, because the obligation travels with the source", () => {
    expect(remotiveIntakeAdapter.attribution).toContain("Remotive");
    expect(remotiveIntakeAdapter.sourceCode).toBe("remotive");
    expect(vi.isMockFunction(remotiveIntakeAdapter.fetchLiveJobs)).toBe(false);
  });
});
