/**
 * Which source answers for a given market — the decision half of cross-border
 * discovery, kept pure so it can be tested without a network call.
 *
 * WHY ROUTING EXISTS AT ALL. A candidate based in India may target jobs in the US,
 * the UK or the UAE. One source cannot serve every market: Adzuna takes the market
 * as a URL path segment and therefore returns STRUCTURED country data, but serves
 * only the markets below. SerpApi takes a free-text location and covers the rest,
 * at a cost - see the quota note in ./adapters/serpapi.ts (100 searches per MONTH).
 *
 * SO THE SPLIT IS "CHEAP AND STRUCTURED WHERE POSSIBLE, EXPENSIVE AND UNSTRUCTURED
 * WHERE NECESSARY", and this module is the single place that decides which.
 */

/**
 * The markets Adzuna serves.
 *
 * COPIED FROM A REAL 404, WHICH IS THE ONLY AUTHORITATIVE LIST. Adzuna's docs were
 * not readable and guessing the set would have been a silent filter: a market
 * believed supported but actually unsupported fails at request time, and one
 * believed unsupported but actually supported wastes a scarce SerpApi search.
 * The body was:
 *   {"exception":"UNSUPPORTED_COUNTRY","display":"The currently supported ISO 3166
 *    country codes are at, au, be, br, ca, ch, de, es, fr, gb, in, it, mx, nl, nz,
 *    pl, sg, us, za"}
 *
 * THAT IS NINETEEN, not the twenty an earlier note in this work claimed, and the
 * test asserts the real number rather than the remembered one.
 *
 * IT IS HARDCODED, deliberately, AND THE DRIFT IS TESTED RATHER THAN ASSUMED. A
 * live check in the default suite would make a third-party outage into a build
 * failure; the assertion that these all return 200 - and that AE does not - belongs
 * in the opt-in integration suite instead.
 */
export const ADZUNA_SUPPORTED_MARKETS = [
  "AT", "AU", "BE", "BR", "CA", "CH", "DE", "ES", "FR", "GB",
  "IN", "IT", "MX", "NL", "NZ", "PL", "SG", "US", "ZA",
] as const;

export type MarketSource = "adzuna" | "serpapi";

/**
 * The source that should answer for this market, or null when the input is not a
 * market at all.
 *
 * NULL RATHER THAN A DEFAULT, AND THAT MATTERS. Defaulting a malformed code to
 * either source would spend a SerpApi search on a typo or ask Adzuna for a market
 * it does not have. A caller that gets null must decide what to tell the candidate;
 * what it must not do is silently search somewhere.
 *
 * Normalised to upper case because the code arrives from candidate preferences,
 * where "gb" and "GB" are the same intent and Adzuna's path segment is lower-case
 * while its stored column is upper-case.
 */
export function routeMarket(code: string): MarketSource | null {
  const normalized = code.trim().toUpperCase();

  if (!/^[A-Z]{2}$/.test(normalized)) {
    return null;
  }

  return (ADZUNA_SUPPORTED_MARKETS as readonly string[]).includes(normalized) ? "adzuna" : "serpapi";
}

/**
 * Splits a candidate's market list into the two source buckets, preserving order
 * and dropping anything that is not a market.
 *
 * THE WHOLE LIST IS ROUTED BEFORE ANYTHING IS FETCHED, so the cost of a request is
 * knowable in advance: `serpapi` is one scarce search per entry, and a caller that
 * wants to cap or ask permission can do so from this shape rather than discovering
 * the cost halfway through a loop.
 */
export function routeMarkets(codes: readonly string[]): {
  adzuna: string[];
  serpapi: string[];
  unusable: string[];
} {
  const adzuna: string[] = [];
  const serpapi: string[] = [];
  const unusable: string[] = [];

  for (const code of codes) {
    const normalized = code.trim().toUpperCase();
    const source = routeMarket(normalized);

    if (source === null) {
      unusable.push(code);
      continue;
    }

    (source === "adzuna" ? adzuna : serpapi).push(normalized);
  }

  return { adzuna, serpapi, unusable };
}
