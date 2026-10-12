import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { runIntakeAcrossSources, type RunIntakeDeps, type RunIntakeInput, type RunIntakeResult } from "./intake.js";

/**
 * The multi-market fan-out: a market-routed source is fetched ONCE PER MARKET, and a
 * source that is not market-routed is untouched by any of it.
 *
 * The registry is mocked with the two real market-routed codes plus one ordinary
 * source, so these cases exercise the routing decision without a network call and
 * without spending a SerpApi search.
 */
vi.mock("./adapters/registry.js", () => ({
  listIntakeAdapters: () => [
    { sourceCode: "adzuna", displayName: "Adzuna", attribution: "Adzuna attribution." },
    { sourceCode: "serpapi", displayName: "SerpApi", attribution: "SerpApi attribution." },
    { sourceCode: "alpha", displayName: "Alpha", attribution: "Alpha attribution." },
  ],
  getIntakeAdapter: () => {
    throw new Error("getIntakeAdapter is not used by the fan-out");
  },
}));

const client = {} as SupabaseClient;

function sourceResult(sourceCode: string, created = 1): RunIntakeResult {
  const outcomes = Array.from({ length: created }, (_, index) => ({
    vacancyId: `${sourceCode}-new-${index}`,
    title: "New",
    companyName: "Acme",
    outcome: "created",
    trustStatus: "VERIFIED_INCOMPLETE",
  }));

  return {
    sourceCode,
    displayName: sourceCode.charAt(0).toUpperCase() + sourceCode.slice(1),
    attribution: sourceCode + " attribution.",
    search: null,
    received: created,
    skippedByAdapter: 0,
    ingested: outcomes.length,
    trustStatusCounts: outcomes.length > 0 ? { VERIFIED_INCOMPLETE: outcomes.length } : {},
    outcomes,
    durationMs: 1,
  } as unknown as RunIntakeResult;
}

/** Records every per-source input the fan-out asked for. */
function recorder(behaviour?: (input: RunIntakeInput) => void) {
  const inputs: RunIntakeInput[] = [];
  const runOne = async (_client: SupabaseClient, input: RunIntakeInput): Promise<RunIntakeResult> => {
    inputs.push(input);
    behaviour?.(input);
    return sourceResult(input.sourceCode);
  };
  return { inputs, deps: { runOne } as RunIntakeDeps };
}

describe("runIntakeAcrossSources - cross-border markets", () => {
  it("fetches a market-routed source ONCE PER MARKET, tagging each summary", async () => {
    const { inputs, deps } = recorder();

    const result = await runIntakeAcrossSources(client, { countries: ["GB", "US"] }, deps);

    const adzuna = inputs.filter((input) => input.sourceCode === "adzuna");
    // LOWER-CASE, and this is not cosmetic. Adzuna takes the country as a URL path
    // segment and its segments are lower-case: /jobs/gb/ answers 200, /jobs/GB/ answers
    // 404. resolveCountry lower-cases for exactly this reason; the router labels in
    // upper-case, so the conversion has to happen here.
    expect(adzuna.map((input) => input.country)).toEqual(["gb", "us"]);

    const summaries = result.sources.filter((source) => source.sourceCode === "adzuna");
    expect(summaries.map((source) => source.market)).toEqual(["GB", "US"]);
    // One source can now appear more than once, so the code alone no longer identifies
    // a row - which is what the market field is for.
    expect(summaries).toHaveLength(2);
  });

  it("routes an unmapped market to SerpApi, sending the COUNTRY NAME as free text", async () => {
    const { inputs, deps } = recorder();

    await runIntakeAcrossSources(client, { countries: ["AE"] }, deps);

    const serpapi = inputs.filter((input) => input.sourceCode === "serpapi");
    expect(serpapi).toHaveLength(1);
    // A bare "AE" is free text Google would have to interpret; the name is unambiguous.
    expect(serpapi[0].location).toBe("United Arab Emirates");
    // The code travels lower-case for the adapter, but what SerpApi actually receives as
    // free text is the NAME - that is the whole point of the mapping.
    expect(serpapi[0].country).toBe("ae");
    // And Adzuna is NOT asked for a market it does not serve.
    expect(inputs.filter((input) => input.sourceCode === "adzuna")).toHaveLength(1);
    expect(inputs.find((input) => input.sourceCode === "adzuna")?.country).toBeUndefined();
  });

  it("sends Adzuna a LOWER-CASE market, because its URL path segment is lower-case", async () => {
    // Live evidence: /jobs/GB/search/1 returned HTTP 404 and /jobs/gb/search/1 returned
    // 200 with 118,712 results. Getting this wrong makes EVERY market fail, which is
    // the silent-looking failure this suite exists to prevent.
    const { inputs, deps } = recorder();

    await runIntakeAcrossSources(client, { countries: ["GB"] }, deps);

    const adzuna = inputs.find((input) => input.sourceCode === "adzuna");
    expect(adzuna?.country).toBe("gb");

    // The LABEL keeps its canonical upper-case form, so a summary still reads GB.
    const result = await runIntakeAcrossSources(client, { countries: ["GB"] }, deps);
    expect(result.sources.find((source) => source.sourceCode === "adzuna")?.market).toBe("GB");
  });

  it("leaves a source that is NOT market-routed completely alone", async () => {
    const { inputs, deps } = recorder();

    const result = await runIntakeAcrossSources(client, { countries: ["GB", "AE"] }, deps);

    const alpha = inputs.filter((input) => input.sourceCode === "alpha");
    expect(alpha).toHaveLength(1);
    // No market is invented for it, and it keeps the caller's shared context.
    expect(alpha[0].country).toBeUndefined();
    expect(alpha[0].location).toBeUndefined();

    // And it is tagged with no market, because it was never fetched for one.
    expect(result.sources.find((source) => source.sourceCode === "alpha")?.market).toBeNull();
  });

  it("RELIABILITY GUARD: a failing market costs only that market", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = recorder((input) => {
      // Lower-case: the adapter receives the market in the case its URL needs.
      if (input.country === "us") throw new Error("Adzuna discovery failed: HTTP 429");
    });

    const result = await runIntakeAcrossSources(client, { countries: ["GB", "US"] }, deps);

    const summaries = result.sources.filter((source) => source.sourceCode === "adzuna");
    expect(summaries.map((source) => [source.market, source.status])).toEqual([
      ["GB", "ok"],
      ["US", "failed"],
    ]);
    // failedSources now counts skipped (source, market) runs, not just sources.
    expect(result.failedSources).toBe(1);
    errorSpy.mockRestore();
  });

  it("surfaces market codes the router could not use, instead of dropping them", async () => {
    const { deps } = recorder();

    const result = await runIntakeAcrossSources(client, { countries: ["GB", "USA"] }, deps);

    expect(result.unusableMarkets).toEqual(["USA"]);
    expect(result.sources.some((source) => source.market === "GB")).toBe(true);
  });

  it("behaves EXACTLY as before when the caller supplies no markets", async () => {
    const { inputs, deps } = recorder();

    const result = await runIntakeAcrossSources(client, { country: "GB" }, deps);

    expect(inputs).toHaveLength(3);
    expect(inputs.map((input) => input.sourceCode)).toEqual(["adzuna", "serpapi", "alpha"]);
    // Every source keeps the single shared context, and no market is tagged.
    expect(inputs.every((input) => input.country === "GB")).toBe(true);
    expect(result.sources.every((source) => source.market === null)).toBe(true);
    expect(result.unusableMarkets).toBeUndefined();
  });
});
