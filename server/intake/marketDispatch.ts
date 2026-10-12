import type { DiscoveredVacancy } from "../ingestion/types.js";
import type { IntakeFetchResult } from "./adapters/types.js";
import type { MarketFetch, MarketPlan, MarketSource } from "./marketRouting.js";

/**
 * Run a market plan, one fetch per market, and survive a market failing.
 *
 * WHY THIS IS NOT JUST A for-LOOP IN THE CALLER. The two things that make cross-border
 * fetching safe are easy to lose when the loop lives inline: a failure must cost only
 * the market that failed, and a partial result must SAY it is partial. Both are
 * properties of this function, and both are tested.
 *
 * THE RELIABILITY GUARD IS THE POINT. Markets are independent: SerpApi running out of
 * its 100 monthly searches, or Adzuna timing out on a UK request, must not cost the
 * candidate the US jobs that already came back. Each market is attempted, failures are
 * collected, and the rest of the plan still runs.
 *
 * A FAILURE IS NOT AN ERROR. Nothing is thrown out of here. A plan where 3 of 4
 * markets answered is a SUCCESS with a reported gap, and the caller - not this
 * function - decides whether that is worth telling the user about. What this function
 * refuses to do is return a short list while implying it is complete.
 */

/** Stable and greppable, so a partial fan-out can be found without guessing. */
export const MARKET_FETCH_FAILURE_MARKER = "[intake] market fetch failed";

export interface MarketFailure {
  source: MarketSource;
  market: string;
  message: string;
}

export interface MarketDispatchResult {
  vacancies: DiscoveredVacancy[];
  /** Summed across the markets that answered - NOT the plan's full size. */
  received: number;
  skipped: number;
  /** Markets that failed. Non-empty means partial, not broken. */
  failures: MarketFailure[];
}

/**
 * `callMarket` IS INJECTED rather than imported, and that is what keeps this testable
 * without a network: the real caller switches on `entry.source` and forwards to the
 * matching adapter, while a test passes a plain function and asserts the routing
 * behaviour without spending a SerpApi search or touching Adzuna at all.
 */
export async function dispatchMarketFetches(
  plan: MarketPlan,
  callMarket: (entry: MarketFetch) => Promise<IntakeFetchResult>,
): Promise<MarketDispatchResult> {
  const vacancies: DiscoveredVacancy[] = [];
  const failures: MarketFailure[] = [];
  let received = 0;
  let skipped = 0;

  for (const entry of plan.fetches) {
    try {
      const result = await callMarket(entry);

      vacancies.push(...result.vacancies);
      received += result.received;
      skipped += result.skipped;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      failures.push({ source: entry.source, market: entry.market, message });

      // LOGGED, NOT SILENTLY DROPPED. A fan-out that quietly returns fewer markets
      // than it was asked for is the silent-fallback failure this codebase keeps
      // having to remove, and a partial result is exactly when it is easiest to miss.
      console.error(MARKET_FETCH_FAILURE_MARKER, {
        source: entry.source,
        market: entry.market,
        message,
      });
    }
  }

  return { vacancies, received, skipped, failures };
}
