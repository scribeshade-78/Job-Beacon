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

import { matchesAnyTargetRole } from "./roleTaxonomy.js";

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


/** The job attributes any preference gate judges. OpportunitySummary satisfies it. */
export interface SearchPreferenceJob {
  title: string;
  companyName: string | null;
  /**
   * company_profiles.industry, when the reader has it. The candidate-facing
   * opportunities view does not expose it, so the client never does and the
   * industry gate passes there; the service-role gate reads it and enforces it.
   */
  industry?: string | null;
  remoteType: string | null;
  country?: string | null;
  city?: string | null;
  salary: { max: number | null; currency: string | null };
}

/**
 * The feed/server ledger, deliberately in the same gates shape as
 * application_plans.gate_results so one ineligibilityReasonOf renders both.
 */
export type SearchPreferenceGates = Record<
  "role_match" | "excluded_company" | "excluded_industry" | "work_mode" | "salary" | "location",
  { status: "pass" | "fail"; reasonCode?: string; detail?: Record<string, unknown> }
>;

export interface SearchPreferenceLedger {
  eligible: boolean;
  gates: SearchPreferenceGates;
}

function normalized(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : null;
}

/**
 * The structured, human-readable reason a job is filtered out or refused — the
 * one evaluator both the feed and the server gate call.
 *
 * WHY IT IS SHARED AND NOT DUPLICATED. The client must not show a job the server
 * will refuse, and the server must not refuse a job the client presents as fine;
 * two implementations of "does this match?" would drift exactly where it hurts.
 *
 * LOCATION IS THE ONE PLACE THE CONSUMERS DIFFER, and that is deliberate rather
 * than hidden: location_not_stated fails the SERVER gate (no consent to submit
 * anywhere was ever given) while the feed still shows the job, because manual
 * browsing remains available. isEligibleForFeed below encodes that one
 * difference; everything else is identical.
 */
export function evaluateSearchPreferenceEligibility(
  preferences: SearchPreferences,
  job: SearchPreferenceJob,
): SearchPreferenceLedger {
  const roleConstrained = preferences.targetRoles.length > 0;
  const rolePasses = !roleConstrained || matchesAnyTargetRole(job.title, preferences.targetRoles);

  const company = normalized(job.companyName);
  const excludedCompany =
    company !== null && preferences.exclusions.companies.some((name) => normalized(name) === company);

  // A missing industry is NOT evidence of an excluded industry: nothing to compare.
  const industry = normalized(job.industry);
  const excludedIndustry =
    industry !== null && preferences.exclusions.industries.some((name) => normalized(name) === industry);

  const mode = preferences.workMode;
  const modeConstrained = mode === "remote" || mode === "hybrid" || mode === "on_site";
  const modePasses = !modeConstrained || job.remoteType === mode;

  const min = preferences.salary.min;
  const currency = preferences.salary.currency;
  // Defensive about undefined as well as null: a row read outside the typed
  // mapper can simply lack the column, and a currency we cannot name is "no
  // currency" rather than a crash.
  const jobCurrency =
    typeof job.salary.currency === "string" && job.salary.currency.trim() !== ""
      ? job.salary.currency.trim().toUpperCase()
      : null;
  const salaryPasses =
    min === null ||
    (job.salary.max !== null && job.salary.max >= min && (currency === null || jobCurrency === currency));

  const { countries, cities, openToAny } = preferences.locations;
  const jobCountry = normalized(job.country);
  const jobCity = normalized(job.city);

  let locationPasses: boolean;
  let locationReasonCode: string | undefined;

  if (openToAny) {
    locationPasses = true;
  } else if (countries.length === 0 && cities.length === 0) {
    // Fail closed, and separately from "out of scope": not having stated a
    // location is not consent to submit anywhere.
    locationPasses = false;
    locationReasonCode = "location_not_stated";
  } else {
    const countryMatch = jobCountry !== null && countries.some((name) => normalized(name) === jobCountry);
    const cityMatch = jobCity !== null && cities.some((name) => normalized(name) === jobCity);

    locationPasses = countryMatch || cityMatch;
    locationReasonCode = "location_mismatch";
  }

  const gates: SearchPreferenceGates = {
    role_match: rolePasses
      ? { status: "pass" }
      : { status: "fail", reasonCode: "role_mismatch", detail: { targetRoles: preferences.targetRoles } },
    excluded_company: excludedCompany
      ? { status: "fail", reasonCode: "excluded_company", detail: { companyName: job.companyName } }
      : { status: "pass" },
    excluded_industry: excludedIndustry
      ? { status: "fail", reasonCode: "excluded_industry", detail: { industry: job.industry } }
      : { status: "pass" },
    work_mode: modePasses
      ? { status: "pass" }
      : { status: "fail", reasonCode: "work_mode_mismatch", detail: { workMode: mode, jobWorkMode: job.remoteType } },
    salary: salaryPasses
      ? { status: "pass" }
      : {
          status: "fail",
          reasonCode: "below_min_salary",
          detail: { min, currency, salaryMax: job.salary.max, jobCurrency },
        },
    location: locationPasses
      ? { status: "pass" }
      : {
          status: "fail",
          reasonCode: locationReasonCode,
          detail: { countries, cities, openToAny, jobCountry: job.country, jobCity: job.city },
        },
  };

  return { eligible: Object.values(gates).every((gate) => gate.status === "pass"), gates };
}

/**
 * Whether the FEED should show a job, which is the ledger minus one case: an
 * unstated location does not hide a job from browsing (manual search stays
 * available), while the server gate still refuses to queue it.
 */
export function isEligibleForFeed(preferences: SearchPreferences, job: SearchPreferenceJob): boolean {
  const ledger = evaluateSearchPreferenceEligibility(preferences, job);

  if (ledger.eligible) {
    return true;
  }

  return Object.entries(ledger.gates).every(
    ([name, gate]) =>
      gate.status === "pass" ||
      (name === "location" && gate.reasonCode === "location_not_stated"),
  );
}
