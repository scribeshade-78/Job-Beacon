import { describe, expect, it, vi } from "vitest";
import { dispatchMarketFetches } from "./marketDispatch.js";
import type { MarketFetch } from "./marketRouting.js";
import type { DiscoveredVacancy } from "../ingestion/types.js";

function vacancy(id: string): DiscoveredVacancy {
  return { sourceVacancyId: id } as DiscoveredVacancy;
}

const GB: MarketFetch = { source: "adzuna", market: "GB", location: null };
const AE: MarketFetch = { source: "serpapi", market: "AE", location: "United Arab Emirates" };
const US: MarketFetch = { source: "adzuna", market: "US", location: null };

describe("dispatchMarketFetches", () => {
  it("merges what every market returned, in plan order", async () => {
    const result = await dispatchMarketFetches(
      { fetches: [GB, AE, US], unusable: [], serpapiSearchCost: 1 },
      async (entry) => ({ vacancies: [vacancy(entry.market)], received: 1, skipped: 0 }),
    );

    expect(result.vacancies.map((v) => v.sourceVacancyId)).toEqual(["GB", "AE", "US"]);
    expect(result.received).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it("RELIABILITY GUARD: one market failing does not cost the others their jobs", async () => {
    // The whole point. SerpApi runs out of quota mid-loop, or Adzuna times out: the
    // Adzuna jobs already fetched must still reach the candidate rather than the
    // whole fan-out returning nothing.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await dispatchMarketFetches(
      { fetches: [GB, AE, US], unusable: [], serpapiSearchCost: 1 },
      async (entry) => {
        if (entry.market === "AE") {
          throw new Error("SerpApi search failed: HTTP 429 — out of searches");
        }
        return { vacancies: [vacancy(entry.market)], received: 1, skipped: 0 };
      },
    );

    expect(result.vacancies.map((v) => v.sourceVacancyId)).toEqual(["GB", "US"]);
    expect(result.failures).toEqual([
      { source: "serpapi", market: "AE", message: "SerpApi search failed: HTTP 429 — out of searches" },
    ]);
    // Logged, not silently dropped - a partial fan-out that says nothing about the
    // missing market is the silent-fallback failure this codebase keeps removing.
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("market fetch failed"))).toBe(true);
    errorSpy.mockRestore();
  });

  it("keeps going after a failure rather than abandoning the remaining markets", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const attempted: string[] = [];

    const result = await dispatchMarketFetches(
      { fetches: [GB, AE, US], unusable: [], serpapiSearchCost: 1 },
      async (entry) => {
        attempted.push(entry.market);
        if (entry.market === "AE") throw new Error("boom");
        return { vacancies: [], received: 0, skipped: 0 };
      },
    );

    expect(attempted).toEqual(["GB", "AE", "US"]);
    expect(result.failures).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it("sums the counts across sources and reports EVERY failure, not just the first", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await dispatchMarketFetches(
      { fetches: [GB, AE, US], unusable: [], serpapiSearchCost: 1 },
      async (entry) => {
        if (entry.market !== "GB") throw new Error("down: " + entry.market);
        return { vacancies: [], received: 7, skipped: 3 };
      },
    );

    expect(result.received).toBe(7);
    expect(result.skipped).toBe(3);
    expect(result.failures.map((f) => f.market)).toEqual(["AE", "US"]);
    errorSpy.mockRestore();
  });

  it("does nothing at all for an empty plan", async () => {
    const call = vi.fn();
    const result = await dispatchMarketFetches({ fetches: [], unusable: [], serpapiSearchCost: 0 }, call);

    expect(call).not.toHaveBeenCalled();
    expect(result).toEqual({ vacancies: [], received: 0, skipped: 0, failures: [] });
  });
});
