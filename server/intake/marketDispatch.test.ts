import { describe, expect, it, vi } from "vitest";
import { dispatchMarketFetches } from "./marketDispatch.js";
import type { MarketFetch } from "./marketRouting.js";

const GB: MarketFetch = { source: "adzuna", market: "GB", location: null };
const AE: MarketFetch = { source: "serpapi", market: "AE", location: "United Arab Emirates" };
const US: MarketFetch = { source: "adzuna", market: "US", location: null };

const plan = (...fetches: MarketFetch[]) => ({ fetches, unusable: [], serpapiSearchCost: 0 });

describe("dispatchMarketFetches - generic over the caller's result type", () => {
  it("returns each market's result WITH its entry, so the caller can merge as it needs", async () => {
    // Approach (i): the fan-out's unit is runIntake (which PERSISTS and returns
    // RunIntakeResult), not the adapter-level IntakeFetchResult. Being generic here is
    // what keeps the reliability guard in ONE tested place instead of duplicating it.
    const result = await dispatchMarketFetches(plan(GB, AE, US), async (entry) => ({ persisted: entry.market }));

    expect(result.results).toEqual([
      { entry: GB, result: { persisted: "GB" } },
      { entry: AE, result: { persisted: "AE" } },
      { entry: US, result: { persisted: "US" } },
    ]);
    expect(result.failures).toEqual([]);
    expect(result.stopped).toBe(false);
  });

  it("RELIABILITY GUARD: one market failing does not cost the others their result", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await dispatchMarketFetches(plan(GB, AE, US), async (entry) => {
      if (entry.market === "AE") {
        throw new Error("SerpApi search failed: HTTP 429 — out of searches");
      }
      return { persisted: entry.market };
    });

    expect(result.results.map((r) => r.entry.market)).toEqual(["GB", "US"]);
    expect(result.failures).toEqual([
      { source: "serpapi", market: "AE", message: "SerpApi search failed: HTTP 429 — out of searches" },
    ]);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("market fetch failed"))).toBe(true);
    errorSpy.mockRestore();
  });

  it("keeps going after a failure rather than abandoning the remaining markets", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const attempted: string[] = [];

    const result = await dispatchMarketFetches(plan(GB, AE, US), async (entry) => {
      attempted.push(entry.market);
      if (entry.market === "AE") throw new Error("boom");
      return entry.market;
    });

    expect(attempted).toEqual(["GB", "AE", "US"]);
    expect(result.failures).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it("DEADLINE: stops before STARTING a market, never mid-fetch, and says it stopped", async () => {
    // Same contract as the fan-out's own: an in-flight fetch always completes, so a
    // budget that cut one off would be a lie. Checked per MARKET now, not per source,
    // because one source can be several markets.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let clock = 0;
    const attempted: string[] = [];

    const result = await dispatchMarketFetches(
      plan(GB, AE, US),
      async (entry) => {
        attempted.push(entry.market);
        clock += 10;
        return entry.market;
      },
      { now: () => clock, deadline: 15 },
    );

    expect(attempted).toEqual(["GB", "AE"]);
    expect(result.stopped).toBe(true);
    expect(result.results.map((r) => r.entry.market)).toEqual(["GB", "AE"]);
    errorSpy.mockRestore();
  });

  it("does nothing at all for an empty plan", async () => {
    const call = vi.fn();
    const result = await dispatchMarketFetches(plan(), call);

    expect(call).not.toHaveBeenCalled();
    expect(result).toEqual({ results: [], failures: [], stopped: false });
  });
});
