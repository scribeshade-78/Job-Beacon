import { describe, expect, it } from "vitest";
import { ADZUNA_SUPPORTED_MARKETS, isoCountryName, planMarketFetch, routeMarket } from "./marketRouting.js";

describe("market routing", () => {
  it("holds exactly the 19 markets Adzuna's own API reports", () => {
    // Copied from a real 404 body, which is the only authoritative list:
    //   {"exception":"UNSUPPORTED_COUNTRY","display":"The currently supported ISO
    //    3166 country codes are at, au, be, br, ca, ch, de, es, fr, gb, in, it,
    //    mx, nl, nz, pl, sg, us, za"}
    // NINETEEN, not twenty - an earlier note in this work said twenty and was wrong.
    expect(ADZUNA_SUPPORTED_MARKETS).toHaveLength(19);
    expect(ADZUNA_SUPPORTED_MARKETS).toContain("GB");
    expect(ADZUNA_SUPPORTED_MARKETS).toContain("IN");
  });

  it("PROVES AE is not an Adzuna market - the 404 that started all of this", () => {
    expect(ADZUNA_SUPPORTED_MARKETS).not.toContain("AE");
  });

  it("routes every Adzuna market to adzuna, in any casing", () => {
    for (const code of ADZUNA_SUPPORTED_MARKETS) {
      expect(routeMarket(code)).toBe("adzuna");
      expect(routeMarket(code.toLowerCase())).toBe("adzuna");
      expect(routeMarket(" " + code + " ")).toBe("adzuna");
    }
  });

  it("routes a market Adzuna does not serve to serpapi", () => {
    expect(routeMarket("AE")).toBe("serpapi");
    expect(routeMarket("ae")).toBe("serpapi");
  });

  it("routes EVERY valid ISO-2 code to one source or the other, never neither", () => {
    // The loop must be total. A code that routes nowhere would be silently dropped
    // from a candidate's market list, which is the failure this whole change is
    // about - a country they asked for quietly returning nothing.
    for (const code of ["US", "GB", "IN", "AE", "NG", "JP", "BR", "DE", "ZA", "ZZ"]) {
      expect(["adzuna", "serpapi"]).toContain(routeMarket(code));
    }
  });

  it("returns null for blank input rather than routing a country called ''", () => {
    expect(routeMarket("")).toBeNull();
    expect(routeMarket("   ")).toBeNull();
  });
});

describe("isoCountryName - deterministic, never a network call", () => {
  it("names the markets Adzuna cannot serve, so SerpApi gets words not a code", () => {
    // A bare "AE" against a free-text location is brittle for a reason worth stating:
    // Google could match a company called AE. A name is unambiguous.
    expect(isoCountryName("AE")).toBe("United Arab Emirates");
    expect(isoCountryName("ae")).toBe("United Arab Emirates");
    expect(isoCountryName("GB")).toBe("United Kingdom");
    expect(isoCountryName("IN")).toBe("India");
  });

  it("returns null rather than echoing the code back as if it were a name", () => {
    // Intl returns the input unchanged for a code it does not know. Treating that as
    // a name would send "ZZ" to SerpApi and call it a country.
    expect(isoCountryName("ZZ")).toBeNull();
    expect(isoCountryName("")).toBeNull();
    expect(isoCountryName("USA")).toBeNull();
  });
});

describe("planMarketFetch - the loop's cost is known before it spends anything", () => {
  it("splits a candidate's markets between the two sources", () => {
    const plan = planMarketFetch(["GB", "AE", "US"]);

    expect(plan.fetches).toEqual([
      { source: "adzuna", market: "GB", location: null },
      { source: "serpapi", market: "AE", location: "United Arab Emirates" },
      { source: "adzuna", market: "US", location: null },
    ]);
    expect(plan.unusable).toEqual([]);
  });

  it("reports the SerpApi search cost up front, because it is the scarce resource", () => {
    const plan = planMarketFetch(["GB", "AE", "US", "NG", "JP"]);

    // Adzuna is effectively free; SerpApi is 100 searches a MONTH.
    expect(plan.serpapiSearchCost).toBe(3);
    expect(plan.fetches.filter((f) => f.source === "serpapi")).toHaveLength(3);
  });

  it("DEDUPLICATES, so a repeated market cannot spend two searches", () => {
    const plan = planMarketFetch(["AE", "ae", " AE ", "GB", "gb"]);

    expect(plan.serpapiSearchCost).toBe(1);
    expect(plan.fetches).toEqual([
      { source: "serpapi", market: "AE", location: "United Arab Emirates" },
      { source: "adzuna", market: "GB", location: null },
    ]);
  });

  it("drops junk into unusable instead of spending a search on it", () => {
    const plan = planMarketFetch(["GB", "", "   ", "USA", "1A"]);

    expect(plan.fetches).toEqual([{ source: "adzuna", market: "GB", location: null }]);
    expect(plan.unusable).toEqual(["", "   ", "USA", "1A"]);
  });

  it("returns an empty plan for a candidate with no markets, rather than a default", () => {
    expect(planMarketFetch([])).toEqual({ fetches: [], unusable: [], serpapiSearchCost: 0 });
  });
});
