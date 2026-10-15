import { describe, expect, it, vi } from "vitest";
import { arbeitnowAdapter, remotiveAdapter, theMuseAdapter, DEFAULT_KEYLESS_DISCOVERY_LIMIT } from "./keyless.js";

/**
 * The keyless public aggregators as SCHEDULED DiscoveryAdapters.
 *
 * These wrap the verified intake fetch/mapping rather than re-normalizing the same
 * payload a second time, so the normalization cannot drift between the on-demand and
 * the scheduled path. What is asserted here is the adapter contract around that shared
 * core: the source code, the sweep flag, the limit plumbing and config validation.
 */

const REMOTIVE_PAGE = {
  jobs: [
    {
      id: 42,
      url: "https://remotive.com/remote-jobs/1",
      title: "Data Engineer",
      company_name: "Acme",
      candidate_required_location: "Worldwide",
      publication_date: "2025-03-01T00:00:00Z",
    },
  ],
};

const ARBEITNOW_PAGE = {
  data: [
    {
      slug: "acme-data-engineer-berlin",
      url: "https://www.arbeitnow.com/jobs/1",
      title: "Data Engineer",
      company_name: "Acme",
      remote: true,
      created_at: 1790445314,
      location: "Berlin, Berlin",
    },
  ],
};

const THE_MUSE_PAGE = {
  results: [
    {
      id: 7,
      name: "Data Engineer",
      publication_date: "2025-03-06T00:50:37Z",
      refs: { landing_page: "https://www.themuse.com/jobs/7" },
      company: { name: "Acme" },
      locations: [{ name: "Remote" }],
    },
  ],
};

function jsonFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("keyless discovery adapters", () => {
  it("expose the source codes the scheduled pull names", () => {
    expect(remotiveAdapter.sourceCode).toBe("remotive");
    expect(arbeitnowAdapter.sourceCode).toBe("arbeitnow");
    expect(theMuseAdapter.sourceCode).toBe("themuse");
  });

  it("declare that one page is NOT the whole corpus, so the worker must not expire unseen rows", async () => {
    // The load-bearing safety property. markUnseenVacanciesExpired expires every active
    // vacancy for the target that this run did not see; The Muse returns TWENTY per page,
    // so a sweep that claimed completeness would delete most of the corpus on its first
    // run. Greenhouse/Lever omit the flag (full board), these must not.
    expect(remotiveAdapter.completesSweep).toBe(false);
    expect(arbeitnowAdapter.completesSweep).toBe(false);
    expect(theMuseAdapter.completesSweep).toBe(false);
  });

  it("maps a Remotive page into DiscoveredVacancy rows", async () => {
    const fetchImpl = jsonFetch(REMOTIVE_PAGE);

    const vacancies = await remotiveAdapter.discover("remotive-live", {
      limit: DEFAULT_KEYLESS_DISCOVERY_LIMIT,
    }, fetchImpl);

    expect(vacancies).toHaveLength(1);
    expect(vacancies[0]).toMatchObject({
      sourceVacancyId: "42",
      rawTitle: "Data Engineer",
      companyName: "Acme",
      remoteType: "remote",
    });
    expect(String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])).toContain(
      `limit=${DEFAULT_KEYLESS_DISCOVERY_LIMIT}`,
    );
  });

  it("maps an Arbeitnow page into DiscoveredVacancy rows", async () => {
    const vacancies = await arbeitnowAdapter.discover("job-board-feed", {}, jsonFetch(ARBEITNOW_PAGE));

    expect(vacancies).toHaveLength(1);
    expect(vacancies[0]).toMatchObject({ sourceVacancyId: "acme-data-engineer-berlin", remoteType: "remote" });
  });

  it("maps a Muse page into DiscoveredVacancy rows", async () => {
    const vacancies = await theMuseAdapter.discover("us-remote", {}, jsonFetch(THE_MUSE_PAGE));

    expect(vacancies).toHaveLength(1);
    expect(vacancies[0]).toMatchObject({ sourceVacancyId: "7", rawTitle: "Data Engineer", companyName: "Acme" });
  });

  it("rejects a non-positive or fractional limit instead of fetching something odd", () => {
    expect(() => remotiveAdapter.validateConfig({ limit: 0 })).toThrow(/limit/);
    expect(() => remotiveAdapter.validateConfig({ limit: -5 })).toThrow(/limit/);
    expect(() => remotiveAdapter.validateConfig({ limit: 1.5 })).toThrow(/limit/);
    expect(() => remotiveAdapter.validateConfig({})).not.toThrow();
  });

  it("propagates a source failure rather than reporting an empty sweep", async () => {
    await expect(remotiveAdapter.discover("remotive-live", {}, jsonFetch({}, 503))).rejects.toThrow();
  });
});
