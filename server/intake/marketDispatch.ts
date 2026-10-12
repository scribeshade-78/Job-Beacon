import type { MarketFetch, MarketPlan, MarketSource } from "./marketRouting.js";

/**
 * Run a market plan, one fetch per market, and survive a market failing.
 *
 * WHY THIS IS NOT JUST A for-LOOP IN THE CALLER. Three things that make cross-border
 * fetching safe are easy to lose when the loop lives inline: a failure must cost only
 * the market that failed, the time budget must be checked before STARTING work rather
 * than mid-flight, and a partial result must SAY it is partial. All three are
 * properties of this function, and all three are tested.
 *
 * GENERIC OVER THE RESULT TYPE (approach (i)). The adapter layer's unit is
 * IntakeFetchResult, but the fan-out's unit is runIntake, which PERSISTS and returns
 * RunIntakeResult. Being generic means the reliability guard is implemented and tested
 * exactly once, and the caller supplies the merging it actually needs - rather than
 * having two copies of "a failing market costs only that market", which is the
 * duplication this split exists to avoid.
 *
 * A FAILURE IS NOT AN ERROR. Nothing is thrown out of here. Three of four markets
 * answering is a SUCCESS with a reported gap, and the caller decides whether that is
 * worth telling the user about. What this refuses to do is return a short list while
 * implying it is complete.
 */

/** Stable and greppable, so a partial fan-out can be found without guessing. */
export const MARKET_FETCH_FAILURE_MARKER = "[intake] market fetch failed";

export interface MarketFailure {
  source: MarketSource;
  market: string;
  message: string;
}

export interface MarketDispatchEntry<T> {
  entry: MarketFetch;
  result: T;
}

export interface MarketDispatchResult<T> {
  /** One entry per market that answered, in plan order. */
  results: MarketDispatchEntry<T>[];
  /** Markets that failed. Non-empty means partial, not broken. */
  failures: MarketFailure[];
  /** True when the budget ran out before every market was attempted. */
  stopped: boolean;
}

export interface MarketDispatchOptions {
  /** Injectable clock, so the deadline is testable without waiting. */
  now?: () => number;
  /** Absolute timestamp after which no further market is STARTED. */
  deadline?: number;
}

export async function dispatchMarketFetches<T>(
  plan: MarketPlan,
  callMarket: (entry: MarketFetch) => Promise<T>,
  options: MarketDispatchOptions = {},
): Promise<MarketDispatchResult<T>> {
  const now = options.now ?? (() => Date.now());
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const results: MarketDispatchEntry<T>[] = [];
  const failures: MarketFailure[] = [];
  let stopped = false;

  for (const entry of plan.fetches) {
    // Checked per MARKET, not per source, because one source can be several markets -
    // and checked BEFORE starting, never mid-fetch: a request already in flight cannot
    // be stopped, so pretending otherwise would make the budget a lie.
    if (now() >= deadline) {
      stopped = true;
      break;
    }

    try {
      results.push({ entry, result: await callMarket(entry) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      failures.push({ source: entry.source, market: entry.market, message });

      // LOGGED, NOT SILENTLY DROPPED. A fan-out that quietly returns fewer markets than
      // it was asked for is the silent-fallback failure this codebase keeps having to
      // remove, and a partial result is exactly when it is easiest to miss.
      console.error(MARKET_FETCH_FAILURE_MARKER, {
        source: entry.source,
        market: entry.market,
        message,
      });
    }
  }

  return { results, failures, stopped };
}

/**
 * Whether this source is fetched per-market rather than once.
 *
 * THE FAN-OUT ASKS THIS QUESTION, NEVER "is this Adzuna". The fan-out deliberately has
 * no per-source knowledge - teaching it "Adzuna needs a country" would put one source's
 * requirements in the shared layer, which is the coupling the adapter registry exists
 * to avoid. It is allowed to know that SOME sources are market-routed, and this module
 * - which already owns Adzuna's supported market list - is the right place to decide
 * which ones.
 *
 * A source absent from this list keeps its single-fetch behaviour, so adding one here
 * is the only change needed to opt a new adapter into cross-border fetching.
 */
export const MARKET_ADDRESSABLE_SOURCES: readonly string[] = ["adzuna", "serpapi"];

export function isMarketAddressable(sourceCode: string): boolean {
  return MARKET_ADDRESSABLE_SOURCES.includes(sourceCode);
}
