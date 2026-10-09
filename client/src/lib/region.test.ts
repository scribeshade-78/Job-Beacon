import { describe, expect, it } from "vitest";
import { BILLING_REGIONS } from "../../../shared/pricing";
import { detectRegion, detectRegionFromBrowser } from "./region";

describe("detectRegion", () => {
  it("maps the Indian timezones to IN", () => {
    expect(detectRegion("Asia/Kolkata", "en-IN")).toBe("IN");
    expect(detectRegion("Asia/Calcutta", "en-IN")).toBe("IN");
  });

  it("maps American timezones to US", () => {
    expect(detectRegion("America/New_York", "en-US")).toBe("US");
    expect(detectRegion("America/Los_Angeles", "en-US")).toBe("US");
    expect(detectRegion("America/Sao_Paulo", "pt-BR")).toBe("US");
  });

  /**
   * The ordering guard: a generic "Europe/" prefix test would classify London as
   * EU and show a UK candidate euro prices.
   */
  it("maps London to UK and does not let the Europe prefix swallow it", () => {
    expect(detectRegion("Europe/London", "en-GB")).toBe("UK");
  });

  it("maps other European timezones to EU", () => {
    expect(detectRegion("Europe/Berlin", "de-DE")).toBe("EU");
    expect(detectRegion("Europe/Paris", "fr-FR")).toBe("EU");
    expect(detectRegion("Europe/Madrid", "es-ES")).toBe("EU");
  });

  it("falls back to the locale when the timezone says nothing", () => {
    expect(detectRegion("Asia/Dubai", "en-IN")).toBe("IN");
    expect(detectRegion("", "en-US")).toBe("US");
    expect(detectRegion(null, "en-GB")).toBe("UK");
    expect(detectRegion(undefined, "de-DE")).toBe("EU");
  });

  it("accepts the legacy underscore locale form", () => {
    expect(detectRegion("", "en_GB")).toBe("UK");
  });

  /**
   * US rather than IN: an unplaceable visitor must not default to the cheapest
   * region, or the least identifiable visitors get the largest discount.
   */
  it("defaults to US when nothing is recognisable", () => {
    expect(detectRegion("", "")).toBe("US");
    expect(detectRegion(null, null)).toBe("US");
    expect(detectRegion("Pacific/Auckland", "en-NZ")).toBe("US");
    expect(detectRegion("UTC", "zz")).toBe("US");
  });

  it("always returns a region the catalogue prices", () => {
    for (const tz of ["Asia/Kolkata", "America/Chicago", "Europe/London", "Europe/Rome", "nonsense"]) {
      expect(BILLING_REGIONS as readonly string[]).toContain(detectRegion(tz, "en"));
    }
  });
});

describe("detectRegionFromBrowser", () => {
  it("returns one of the four priced regions", () => {
    // The specific answer depends on the test runner's locale, so the assertion
    // is that it always lands on a region the catalogue can price.
    expect(BILLING_REGIONS as readonly string[]).toContain(detectRegionFromBrowser());
  });
});

// regionalAutoApplyQuota's tests were removed with the helper: the monthly
// auto-apply figure is no longer shown to candidates, because no plan can
// consume it. The catalogue still holds the numbers for the seed and the
// parity test, which is why nothing here asserts their values.
