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

/**
 * The English display name for an ISO-2 region code, or null.
 *
 * WHY A NAME AND NOT THE CODE. SerpApi's `location` is free text handed to Google,
 * so a bare "AE" is unstructured input the API has to guess at - it could match a
 * company called AE rather than the country. A name is unambiguous, and this is
 * deterministic: no network call, so resolving a name cannot fail for a reason
 * unrelated to the request and cannot spend a search.
 */
export function isoCountryName(code: string): string | null {
  const normalized = code.trim().toUpperCase();

  if (!/^[A-Z]{2}$/.test(normalized)) {
    return null;
  }

  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(normalized);

    if (typeof name !== "string" || name.length === 0) {
      return null;
    }

    // INTL ANSWERS UNHELPFULLY FOR A CODE IT DOES NOT KNOW: it echoes the code back,
    // or returns the literal "Unknown Region". Neither is a country name, and
    // sending either to a search API is worse than sending nothing at all.
    if (name.toUpperCase() === normalized || name === "Unknown Region") {
      return null;
    }

    return name;
  } catch {
    // Intl.DisplayNames is absent in a stripped ICU build. Returning null keeps that
    // a routing gap rather than a crash in the middle of a fan-out.
    return null;
  }
}

export interface MarketFetch {
  source: MarketSource;
  /** ISO-2, upper case - what Adzuna takes as its URL path segment. */
  market: string;
  /** For serpapi, the free-text location to send. For adzuna, null: it takes the code. */
  location: string | null;
}

export interface MarketPlan {
  fetches: MarketFetch[];
  /** Entries that are not usable markets, in the order they arrived. */
  unusable: string[];
  /** SerpApi searches this plan will cost - surfaced BEFORE the loop spends them. */
  serpapiSearchCost: number;
}

/**
 * The whole loop's work, decided before a single request is made.
 *
 * COST BEFORE ACTION. `serpapiSearchCost` is knowable here, so a caller can cap it,
 * report it, or refuse before spending from a 100-per-month budget. A loop that
 * discovered the cost as it went could only report it afterwards.
 *
 * DEDUPLICATED, because "AE", "ae" and " AE " are one market and must not cost three
 * searches. And an entry that routes to SerpApi but has no name is NOT sent as a
 * code: it is reported unusable, on the grounds that a request we cannot phrase
 * correctly is worse than a request we do not make.
 */
export function planMarketFetch(codes: readonly string[]): MarketPlan {
  const fetches: MarketFetch[] = [];
  const unusable: string[] = [];
  const seen = new Set<string>();
  let serpapiSearchCost = 0;

  for (const raw of codes) {
    const normalized = raw.trim().toUpperCase();
    const source = routeMarket(normalized);

    if (source === null) {
      unusable.push(raw);
      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    if (source === "adzuna") {
      fetches.push({ source, market: normalized, location: null });
      continue;
    }

    const location = isoCountryName(normalized);

    if (location === null) {
      unusable.push(raw);
      continue;
    }

    fetches.push({ source, market: normalized, location });
    serpapiSearchCost += 1;
  }

  return { fetches, unusable, serpapiSearchCost };
}
