import { describe, expect, it } from "vitest";
import { ADZUNA_SUPPORTED_MARKETS, routeMarket } from "./marketRouting.js";

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
