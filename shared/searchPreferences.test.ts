import { describe, expect, it } from "vitest";
import {
  buildSearchPreferences,
  locationIntentExplicit,
  type SearchPreferencesInput,
} from "./searchPreferences.js";

/** Every column at its "never set" value, so each test can state only what it means. */
const base: SearchPreferencesInput = {
  preferredCountries: [],
  preferredCities: [],
  remotePreference: null,
  employmentTypes: [],
  minSalary: null,
  minSalaryCurrency: null,
  openToAnyLocation: false,
  excludedCompanies: [],
  excludedIndustries: [],
};

describe("buildSearchPreferences", () => {
  it("returns documented defaults when there is nothing saved", () => {
    expect(buildSearchPreferences(null, [])).toEqual({
      targetRoles: [],
      locations: { countries: [], cities: [], openToAny: false },
      workMode: null,
      salary: { min: null, currency: null },
      employmentTypes: [],
      exclusions: { companies: [], industries: [] },
      isComplete: false,
    });
  });

  it("is incomplete when roles exist but no work mode is stated", () => {
    const preferences = buildSearchPreferences(
      { ...base, preferredCountries: ["India"] },
      ["Data Engineer"],
    );

    expect(preferences.workMode).toBeNull();
    expect(preferences.isComplete).toBe(false);
  });

  it("is complete with roles, an explicit location and an explicit work mode", () => {
    const preferences = buildSearchPreferences(
      { ...base, preferredCountries: ["India"], remotePreference: "remote" },
      ["Data Engineer"],
    );

    expect(preferences.isComplete).toBe(true);
  });

  it("treats openToAnyLocation with no countries or cities as explicit location intent", () => {
    expect(locationIntentExplicit({ countries: [], cities: [], openToAny: true })).toBe(true);

    const preferences = buildSearchPreferences(
      { ...base, openToAnyLocation: true, remotePreference: "any" },
      ["Data Engineer"],
    );

    expect(preferences.locations).toEqual({ countries: [], cities: [], openToAny: true });
    expect(preferences.isComplete).toBe(true);
  });

  it("parses excluded companies and industries from the saved arrays", () => {
    const preferences = buildSearchPreferences(
      { ...base, excludedCompanies: ["Acme, Inc", "  Globex  ", ""], excludedIndustries: ["Gambling"] },
      [],
    );

    expect(preferences.exclusions).toEqual({ companies: ["Acme, Inc", "Globex"], industries: ["Gambling"] });
  });

  it("drops a salary floor that has no currency", () => {
    // Malformed or legacy data: the table CHECK forbids the combination and the
    // save path refuses it, so a floor with no unit is dropped rather than
    // guessed at — 80000 means different things in different currencies.
    const preferences = buildSearchPreferences({ ...base, minSalary: 80000, minSalaryCurrency: null }, []);

    expect(preferences.salary).toEqual({ min: null, currency: null });
  });

  it("keeps a floor that has a currency, normalised to upper case", () => {
    const preferences = buildSearchPreferences({ ...base, minSalary: 80000, minSalaryCurrency: "usd" }, []);

    expect(preferences.salary).toEqual({ min: 80000, currency: "USD" });
  });

  it("keeps a stated 'any' work mode distinct from an unstated one", () => {
    expect(buildSearchPreferences({ ...base, remotePreference: "any" }, []).workMode).toBe("any");
    expect(buildSearchPreferences({ ...base, remotePreference: null }, []).workMode).toBeNull();
  });
});
