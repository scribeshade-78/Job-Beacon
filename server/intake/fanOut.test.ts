import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { runIntakeAcrossSources, type RunIntakeDeps, type RunIntakeResult } from "./intake.js";

/**
 * The fan-out's own logic: isolation between sources, aggregation of their
 * counts, and partial success.
 *
 * The adapter registry is mocked so the run has several sources to fan out over
 * (the real registry has one, so a real fan-out would have nothing to isolate),
 * and the per-source runner is injected through deps.runOne so these cases do
 * not need a Supabase graph. runIntake itself — policy gating, ingestion,
 * scoring — is covered by intake.test.ts.
 */
vi.mock("./adapters/registry.js", () => ({
  listIntakeAdapters: () => [
    { sourceCode: "alpha", displayName: "Alpha", attribution: "Alpha attribution." },
    { sourceCode: "beta", displayName: "Beta", attribution: "Beta attribution." },
    { sourceCode: "gamma", displayName: "Gamma", attribution: "Gamma attribution." },
  ],
  getIntakeAdapter: () => {
    throw new Error("getIntakeAdapter is not used by the fan-out");
  },
}));

const client = {} as SupabaseClient;

/** One source's successful result, with the counts the aggregate is built from. */
function sourceResult(
  sourceCode: string,
  counts: { received?: number; created?: number; updated?: number; skipped?: number } = {},
): RunIntakeResult {
  const created = counts.created ?? 0;
  const updated = counts.updated ?? 0;

  const outcomes = [
    ...Array.from({ length: created }, (_, index) => ({
      vacancyId: `${sourceCode}-new-${index}`,
      title: "New",
      companyName: "Acme",
      outcome: "created",
      trustStatus: "VERIFIED_INCOMPLETE",
    })),
    ...Array.from({ length: updated }, () => ({
      vacancyId: `${sourceCode}-old`,
      title: "Old",
      companyName: "Acme",
      outcome: "updated",
      trustStatus: "VERIFIED_INCOMPLETE",
    })),
  ];

  return {
    sourceCode,
    displayName: sourceCode.charAt(0).toUpperCase() + sourceCode.slice(1),
    attribution: `${sourceCode.charAt(0).toUpperCase()}${sourceCode.slice(1)} attribution.`,
    search: null,
    received: counts.received ?? 0,
    skippedByAdapter: counts.skipped ?? 0,
    ingested: outcomes.length,
    trustStatusCounts: outcomes.length > 0 ? { VERIFIED_INCOMPLETE: outcomes.length } : {},
    outcomes,
    durationMs: 7,
  } as RunIntakeResult;
}

describe("runIntakeAcrossSources", () => {
  it("runs every registered source, in registry order", async () => {
    const runOne = vi.fn(async (_c: SupabaseClient, input: { sourceCode: string }) =>
      sourceResult(input.sourceCode, { received: 1, created: 1 }),
    );

    const result = await runIntakeAcrossSources(client, {}, { runOne } as RunIntakeDeps);

    expect(runOne.mock.calls.map((call) => call[1].sourceCode)).toEqual(["alpha", "beta", "gamma"]);
    expect(result.sources.map((source) => source.sourceCode)).toEqual(["alpha", "beta", "gamma"]);
    expect(result.failedSources).toBe(0);
  });

  it("aggregates the listing counts across every source", async () => {
    const runOne = vi.fn(async (_c: SupabaseClient, input: { sourceCode: string }) => {
      if (input.sourceCode === "alpha") return sourceResult("alpha", { received: 10, created: 2, updated: 1, skipped: 3 });
      if (input.sourceCode === "beta") return sourceResult("beta", { received: 5, created: 1, updated: 0, skipped: 1 });
      return sourceResult("gamma", { received: 0, created: 0, updated: 4, skipped: 0 });
    });

    const result = await runIntakeAcrossSources(client, {}, { runOne } as RunIntakeDeps);

    expect(result.received).toBe(15);
    expect(result.created).toBe(3);
    expect(result.updated).toBe(5);
    expect(result.skippedByAdapter).toBe(4);
    expect(result.ingested).toBe(8);
    // The union matters to the client: these are the rows it marks as new.
    expect(result.newVacancyIds).toEqual(["alpha-new-0", "alpha-new-1", "beta-new-0"]);
    expect(result.trustStatusCounts).toEqual({ VERIFIED_INCOMPLETE: 8 });
  });

  it("skips a failing source and still returns what the others produced", async () => {
    const runOne = vi.fn(async (_c: SupabaseClient, input: { sourceCode: string }) => {
      if (input.sourceCode === "beta") {
        throw new Error("HTTP 503 from beta.example");
      }
      return sourceResult(input.sourceCode, { received: 4, created: 1 });
    });

    const result = await runIntakeAcrossSources(client, {}, { runOne } as RunIntakeDeps);

    // Partial success: the failure costs the candidate nothing from the sources
    // that work. This is the property the whole change exists for.
    expect(result.failedSources).toBe(1);
    expect(result.created).toBe(2);
    expect(result.received).toBe(8);

    const beta = result.sources.find((source) => source.sourceCode === "beta");
    expect(beta).toMatchObject({ status: "failed", error: "HTTP 503 from beta.example", created: 0 });
    // The failed source keeps its attribution, so a caller rendering per-source
    // detail does not have to special-case it.
    expect(beta?.attribution).toBe("Beta attribution.");
  });

  it("keeps every source's attribution, which its terms require to travel with its data", async () => {
    const runOne = vi.fn(async (_c: SupabaseClient, input: { sourceCode: string }) => sourceResult(input.sourceCode));

    const result = await runIntakeAcrossSources(client, {}, { runOne } as RunIntakeDeps);

    expect(result.sources.map((source) => source.attribution)).toEqual([
      "Alpha attribution.",
      "Beta attribution.",
      "Gamma attribution.",
    ]);
  });

  it("reports every source as failed when all of them fail, without throwing", async () => {
    const runOne = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await runIntakeAcrossSources(client, {}, { runOne } as RunIntakeDeps);

    expect(result.sources).toHaveLength(3);
    expect(result.failedSources).toBe(3);
    expect(result.created).toBe(0);
    expect(result.newVacancyIds).toEqual([]);
  });

  it("restricts the run to the requested sources", async () => {
    const runOne = vi.fn(async (_c: SupabaseClient, input: { sourceCode: string }) => sourceResult(input.sourceCode));

    const result = await runIntakeAcrossSources(client, { sourceCodes: ["beta"] }, { runOne } as RunIntakeDeps);

    expect(runOne).toHaveBeenCalledTimes(1);
    expect(result.sources.map((source) => source.sourceCode)).toEqual(["beta"]);
  });

  it("passes the search and limit through to each source", async () => {
    const runOne = vi.fn(async (_c: SupabaseClient, input: { sourceCode: string }) => sourceResult(input.sourceCode));

    await runIntakeAcrossSources(client, { search: "data engineer", limit: 5 }, { runOne } as RunIntakeDeps);

    for (const call of runOne.mock.calls) {
      expect(call[1]).toMatchObject({ search: "data engineer", limit: 5 });
    }
  });
});
