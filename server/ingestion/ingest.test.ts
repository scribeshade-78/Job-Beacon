import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ingestDiscoveredVacancy, markUnseenVacanciesExpired } from "./ingest.js";
import type { DiscoveredVacancy } from "./types.js";

const discovered: DiscoveredVacancy = {
  sourceVacancyId: "job-1",
  authoritativeUrl: "https://acme.example/jobs/1",
  rawTitle: "Backend Engineer",
  companyName: "Acme Corp",
  companyDomain: "acme.example",
  country: "US",
  region: null,
  city: null,
  remoteType: "remote",
  currency: "USD",
  salaryMin: 100000,
  salaryMax: 130000,
  salaryInterval: "year",
  salarySource: "employer_disclosed",
  publishedAt: "2026-08-11T00:00:00Z",
  raw: { id: "job-1", title: "Backend Engineer" },
};

/**
 * A minimal chainable query-builder double. Each call records itself and
 * returns `this` so `.eq().eq().maybeSingle()` etc. chains freely; the
 * configured terminal result is returned by whichever terminal method is
 * called (maybeSingle/single) or by awaiting the builder itself (mirroring
 * supabase-js's PostgrestBuilder being thenable).
 */
function makeBuilder(terminalResult: { data: unknown; error: unknown } = { data: null, error: null }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain = (method: string) => (...args: unknown[]) => (calls.push({ method, args }), builder);
  const terminal = (method: string) => (...args: unknown[]) => (calls.push({ method, args }), terminalResult);

  const builder = {
    calls,
    select: chain("select"),
    eq: chain("eq"),
    order: chain("order"),
    limit: chain("limit"),
    not: chain("not"),
    insert: chain("insert"),
    update: chain("update"),
    upsert: chain("upsert"),
    maybeSingle: terminal("maybeSingle"),
    single: terminal("single"),
    then: (resolve: (v: unknown) => void) => resolve(terminalResult),
  };

  return builder;
}

describe("ingestDiscoveredVacancy", () => {
  it("creates a new vacancy plus version, source record, and fingerprint when nothing matches", async () => {
    const vacancyId = "vacancy-1";

    // companies upsert returns null (simulating a race where a concurrent
    // insert already created it), then the re-select finds it.
    const companyBuilders = [
      makeBuilder({ data: null, error: null }), // select existing -> none
      makeBuilder({ data: null, error: null }), // upsert (ignoreDuplicates) -> null
      makeBuilder({ data: { id: "company-1" }, error: null }), // re-select after race
    ];
    let companyCallIndex = 0;
    const vacancyBuilders = [
      makeBuilder({ data: null, error: null }), // existing by source
      makeBuilder({ data: null, error: null }), // existing by url
      makeBuilder({ data: { id: vacancyId }, error: null }), // insert
    ];
    let vacancyCallIndex = 0;

    const from2 = vi.fn((table: string) => {
      if (table === "companies") return companyBuilders[companyCallIndex++];
      if (table === "vacancies") return vacancyBuilders[vacancyCallIndex++];
      return makeBuilder();
    });
    const client2 = { from: from2 } as unknown as Parameters<typeof ingestDiscoveredVacancy>[0];

    const result = await ingestDiscoveredVacancy(client2, "greenhouse", "target-1", discovered);

    expect(result).toEqual({ vacancyId, outcome: "created" });
    expect(from2).toHaveBeenCalledWith("vacancy_versions");
    expect(from2).toHaveBeenCalledWith("vacancy_source_records");
    expect(from2).toHaveBeenCalledWith("vacancy_fingerprints");
  });

  it("updates the existing vacancy and inserts a new version when content changed", async () => {
    const vacancyId = "vacancy-1";
    const calls: string[] = [];
    const from = vi.fn((table: string) => {
      calls.push(table);

      if (table === "vacancies") {
        return makeBuilder({ data: { id: vacancyId }, error: null });
      }
      if (table === "vacancy_versions") {
        // First call: select latest version (different hash). Second call: insert.
        const alreadyCalled = calls.filter((t) => t === "vacancy_versions").length > 1;
        return makeBuilder(
          alreadyCalled ? { data: null, error: null } : { data: { content_hash: "old-hash" }, error: null },
        );
      }
      return makeBuilder({ data: null, error: null });
    });
    const client = { from } as unknown as Parameters<typeof ingestDiscoveredVacancy>[0];

    const result = await ingestDiscoveredVacancy(client, "greenhouse", "target-1", discovered);

    expect(result).toEqual({ vacancyId, outcome: "updated" });
  });

  it("returns 'unchanged' without inserting a new version when the content hash matches", async () => {
    const vacancyId = "vacancy-1";
    let versionSelectDone = false;
    const from = vi.fn((table: string) => {
      if (table === "vacancies") {
        return makeBuilder({ data: { id: vacancyId }, error: null });
      }
      if (table === "vacancy_versions" && !versionSelectDone) {
        versionSelectDone = true;
        // Same hash the function computes for `discovered.raw`.
        return makeBuilder({
          data: { content_hash: createHash("sha256").update(JSON.stringify(discovered.raw)).digest("hex") },
          error: null,
        });
      }
      return makeBuilder({ data: null, error: null });
    });
    const client = { from } as unknown as Parameters<typeof ingestDiscoveredVacancy>[0];

    const result = await ingestDiscoveredVacancy(client, "greenhouse", "target-1", discovered);

    expect(result).toEqual({ vacancyId, outcome: "unchanged" });
  });

  it("merges as a source record instead of creating a duplicate when the URL matches under a different source id", async () => {
    const existingVacancyId = "vacancy-existing";
    let vacanciesCallIndex = 0;
    const from = vi.fn((table: string) => {
      if (table === "vacancies") {
        vacanciesCallIndex += 1;
        // 1st call: no match by (source_code, source_vacancy_id). 2nd: match by URL.
        return makeBuilder(
          vacanciesCallIndex === 1 ? { data: null, error: null } : { data: { id: existingVacancyId }, error: null },
        );
      }
      return makeBuilder({ data: null, error: null });
    });
    const client = { from } as unknown as Parameters<typeof ingestDiscoveredVacancy>[0];

    const result = await ingestDiscoveredVacancy(client, "adzuna", "target-2", discovered);

    expect(result).toEqual({ vacancyId: existingVacancyId, outcome: "merged_as_source_record" });
    expect(from).not.toHaveBeenCalledWith("companies");
  });
});

describe("markUnseenVacanciesExpired", () => {
  it("filters to the target's active vacancies and excludes the seen ids", async () => {
    const builder = makeBuilder({ data: null, error: null });
    const from = vi.fn(() => builder);
    const client = { from } as unknown as Parameters<typeof markUnseenVacanciesExpired>[0];

    await markUnseenVacanciesExpired(client, "target-1", ["v1", "v2"]);

    expect(builder.calls).toContainEqual({ method: "update", args: [expect.objectContaining({ status: "expired" })] });
    expect(builder.calls).toContainEqual({ method: "eq", args: ["vacancy_source_id", "target-1"] });
    expect(builder.calls).toContainEqual({ method: "eq", args: ["status", "active"] });
    expect(builder.calls).toContainEqual({ method: "not", args: ["id", "in", "(v1,v2)"] });
  });

  it("skips the not-in filter entirely when nothing was seen (marks everything for that target expired)", async () => {
    const builder = makeBuilder({ data: null, error: null });
    const from = vi.fn(() => builder);
    const client = { from } as unknown as Parameters<typeof markUnseenVacanciesExpired>[0];

    await markUnseenVacanciesExpired(client, "target-1", []);

    expect(builder.calls.some((c) => c.method === "not")).toBe(false);
  });
});
