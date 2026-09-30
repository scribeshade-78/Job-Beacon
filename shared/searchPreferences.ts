/**
 * One saved SearchPreferences object — the single shape every downstream system
 * (the feed query, the feed's eligibility ledger, and later the server gate)
 * reads, instead of each re-deriving "what is this candidate looking for" from
 * candidate_preferences and candidate_selected_roles in its own way.
 *
 * WHY IT IS PURE. buildSearchPreferences takes already-read values and returns
 * the object; it performs no I/O, holds no clock and imports no client. The
 * loader that reads the two tables is a thin separate function, so the rule is
 * testable without a database or a Supabase client — the same split
 * shared/readiness.ts and shared/pipelineStages.ts already use.
 *
 * NULL IS NOT 'any'. remote_preference NULL means "the candidate has not said",
 * while 'any' means "they said they do not mind". Readiness treats the first as
 * incomplete and the second as stated, so the two must stay distinguishable.
 */

export type SearchWorkMode = "remote" | "hybrid" | "on_site" | "any";

/**
 * The parsed candidate_preferences values this builder consumes.
 *
 * Declared structurally rather than importing the client's CandidatePreferences,
 * because shared/ cannot depend on a client module. The client's parser already
 * produces exactly this shape.
 */
export interface SearchPreferencesInput {
  preferredCountries: string[] | null;
  preferredCities: string[] | null;
  remotePreference: string | null;
  employmentTypes: string[] | null;
  minSalary: number | null;
  minSalaryCurrency: string | null;
  openToAnyLocation: boolean | null;
  excludedCompanies: string[] | null;
  excludedIndustries: string[] | null;
}

export interface SearchLocations {
  countries: string[];
  cities: string[];
  /** True means any location is acceptable, so countries/cities are no restriction. */
  openToAny: boolean;
}

export interface SearchSalary {
  /** null when no floor is stated, or when the stored floor had no usable currency. */
  min: number | null;
  currency: string | null;
}

export interface SearchExclusions {
  companies: string[];
  industries: string[];
}

export interface SearchPreferences {
  targetRoles: string[];
  locations: SearchLocations;
  /** null is "not stated" and is deliberately NOT the same as "any". */
  workMode: SearchWorkMode | null;
  salary: SearchSalary;
  /** Stored and surfaced, but NOT applied: vacancies carry no employment_type column. */
  employmentTypes: string[];
  exclusions: SearchExclusions;
  /**
   * Search-preference completeness ONLY: roles, an explicit work mode and an
   * explicit location intent. Deliberately NOT full setup readiness — resume and
   * submission consent are not part of this object (Phase 0 decision).
   */
  isComplete: boolean;
}

/** Trimmed, blank-free copy of a stored text[] value. Order is preserved. */
function cleanList(values: readonly string[] | null | undefined): string[] {
  return (values ?? [])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
}

/** The four stored values, or null for anything unrecognised (including NULL). */
function normalizeWorkMode(value: string | null | undefined): SearchWorkMode | null {
  return value === "remote" || value === "hybrid" || value === "on_site" || value === "any" ? value : null;
}

/**
 * Sanitises the stored salary floor.
 *
 * A FLOOR WITHOUT A CURRENCY IS DROPPED. The table's own CHECK forbids the
 * combination and the save path refuses it, so this can only be malformed or
 * legacy data — and "80000" with no unit is not a filterable floor (80000 INR
 * and 80000 USD are not the same constraint), so keeping the number would
 * silently mis-filter. It is dropped rather than guessed at.
 */
function normalizeSalary(min: number | null | undefined, currency: string | null | undefined): SearchSalary {
  const normalizedCurrency =
    typeof currency === "string" && currency.trim() !== "" ? currency.trim().toUpperCase() : null;

  if (min === null || min === undefined) {
    return { min: null, currency: null };
  }

  if (normalizedCurrency === null) {
    return { min: null, currency: null };
  }

  return { min, currency: normalizedCurrency };
}

/** Explicit geographic intent: a named place, or the explicit "anywhere" flag. */
export function locationIntentExplicit(locations: SearchLocations): boolean {
  return locations.openToAny || locations.countries.length > 0 || locations.cities.length > 0;
}

/** An explicit work mode. NULL means "not stated" and is not explicit. */
export function workModeStated(workMode: SearchWorkMode | null): boolean {
  return workMode !== null;
}

/**
 * Merges the two saved stores into the one object.
 *
 * A null preferences row is the normal state for a candidate who never opened
 * the form, and an empty role list is normal before they choose roles — neither
 * is an error, and both produce the documented defaults.
 */
export function buildSearchPreferences(
  preferences: SearchPreferencesInput | null,
  roleNames: readonly string[] | null | undefined,
): SearchPreferences {
  const targetRoles = cleanList(roleNames);

  const locations: SearchLocations = {
    countries: cleanList(preferences?.preferredCountries),
    cities: cleanList(preferences?.preferredCities),
    openToAny: preferences?.openToAnyLocation === true,
  };

  const workMode = normalizeWorkMode(preferences?.remotePreference);

  return {
    targetRoles,
    locations,
    workMode,
    salary: normalizeSalary(preferences?.minSalary, preferences?.minSalaryCurrency),
    employmentTypes: cleanList(preferences?.employmentTypes),
    exclusions: {
      companies: cleanList(preferences?.excludedCompanies),
      industries: cleanList(preferences?.excludedIndustries),
    },
    isComplete: targetRoles.length > 0 && workModeStated(workMode) && locationIntentExplicit(locations),
  };
}
