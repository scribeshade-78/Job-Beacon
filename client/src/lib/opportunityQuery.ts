import {
  DEFAULT_SORT,
  FRESHNESS_WINDOWS,
  PREFERENCE_EXCLUSIONS,
  SORT_FIELDS_BY_ID,
  VACANCY_FILTERS,
  type FreshnessValue,
  type PreferenceKey,
  type SortId,
} from "../../../shared/opportunityQuery";
import { matchesAnyTargetRole } from "./roleTaxonomy";
import { EMPTY_PREFERENCES, type CandidatePreferences } from "./candidatePreferences";
import type { SearchPreferences } from "../../../shared/searchPreferences";

/**
 * Task I — turning the shared spec plus a filter state into a PostgREST query,
 * and deriving that state's starting values from the candidate's preferences.
 *
 * THE SEPARATION THIS FILE ENFORCES. A preference is durable and belongs to the
 * candidate; a filter is transient and belongs to one search. They overlap on
 * location, work mode and salary, and the overlap is where duplication creeps
 * in. The rule implemented here is: the filter's INITIAL value is derived from
 * the preference, and the UI labels a filter that still equals that derived
 * value as inherited rather than asking the candidate to state it twice.
 * Nothing is copied into a second durable store — if the preference changes, the
 * next derivation picks it up.
 *
 * EXCLUSIONS ARE NOT FILTERS. excludedCompanies and excludedIndustries are
 * standing constraints applied to every query. They have no control in the
 * filter bar, because the candidate already stated them once and a second input
 * for the same thing is exactly the clutter this task is removing.
 */

export interface OpportunityFilters {
  freshness: FreshnessValue | null;
  countries: string[];
  cities: string[];
  workModes: string[];
  /** Declared for shape parity with the spec. Nothing backs it; never applied. */
  employmentTypes: string[];
  minSalary: number | null;
  minSalaryCurrency: string | null;
  /** Declared for shape parity. Nothing backs it; never applied. */
  seniorities: string[];
  companies: string[];
  trustStatuses: string[];
  applicationStatuses: string[];
  sources: string[];
}

export const EMPTY_FILTERS: OpportunityFilters = {
  freshness: null,
  countries: [],
  cities: [],
  workModes: [],
  employmentTypes: [],
  minSalary: null,
  minSalaryCurrency: null,
  seniorities: [],
  companies: [],
  trustStatuses: [],
  applicationStatuses: [],
  sources: [],
};

/**
 * The filter's starting state, derived from the profile.
 *
 * Only the three fields that genuinely overlap are seeded. Employment type is
 * deliberately NOT seeded even though a preference exists for it: the filter has
 * no backing column, so seeding it would fill a disabled control with a value
 * and imply it was doing something.
 */
export function deriveFiltersFromPreferences(
  preferences: CandidatePreferences | null,
): OpportunityFilters {
  if (!preferences) {
    return { ...EMPTY_FILTERS };
  }

  return {
    ...EMPTY_FILTERS,
    countries: preferences.preferredCountries ?? [],
    // remotePreference null means "not stated"; 'any' is a stated non-preference.
    // Seeding from null leaves the filter open, which is the same visible result
    // but is reported differently by inheritedFilterLabels below.
    workModes: preferences.remotePreference && preferences.remotePreference !== "any"
      ? [preferences.remotePreference]
      : [],
    minSalary: preferences.minSalary ?? null,
    minSalaryCurrency: preferences.minSalaryCurrency ?? null,
  };
}

/**
 * The filters that have a profile counterpart. Adding a key here is what makes a
 * filter inheritable; the derivation itself lives in deriveFiltersFromPreferences,
 * so this list and that function are the only two places the mapping exists.
 */
const FILTER_TO_PREFERENCE: Partial<Record<keyof OpportunityFilters, PreferenceKey>> = {
  countries: "preferredCountries",
  workModes: "remotePreference",
  minSalary: "minSalary",
};

/**
 * Which filters still hold exactly the value the profile implies.
 *
 * COMPARED AGAINST THE DERIVED FILTER STATE, NOT AGAINST THE RAW PREFERENCE. An
 * earlier version compared the filter to the preference field directly and was
 * wrong for work mode: the preference is a scalar ("remote") while the filter is
 * a list (["remote"]), so the two could never be equal and the inherited label
 * never appeared for the one field most likely to be inherited. Re-deriving and
 * comparing filter-to-filter asks the question that actually matters — "is this
 * control still where the profile put it?" — and cannot drift from
 * deriveFiltersFromPreferences because it calls it.
 *
 * The UI uses this to render "from your preferences" beside a control instead of
 * repeating the input; the label disappears the moment the candidate changes it
 * for this search, which is what makes it honest rather than decorative.
 */
export function inheritedFilterLabels(
  filters: OpportunityFilters,
  preferences: CandidatePreferences | null,
): string[] {
  if (!preferences) {
    return [];
  }

  const derived = deriveFiltersFromPreferences(preferences);
  const inherited: string[] = [];

  for (const key of Object.keys(FILTER_TO_PREFERENCE) as Array<keyof OpportunityFilters>) {
    const defaultValue = derived[key];

    // A preference that states nothing seeds nothing, so a filter holding
    // nothing was not inherited — there was nothing to inherit from. Without
    // this, every empty filter on a brand-new account would claim to come from
    // the profile.
    if (Array.isArray(defaultValue) ? defaultValue.length === 0 : defaultValue === null) {
      continue;
    }

    if (JSON.stringify(filters[key]) === JSON.stringify(defaultValue)) {
      inherited.push(key as string);
    }
  }

  return inherited;
}

/** Counts filters the candidate has actually narrowed, for the "N active" badge. */
export function countActiveFilters(filters: OpportunityFilters): number {
  return VACANCY_FILTERS.filter((spec) => {
    switch (spec.id) {
      case "freshness":
        return filters.freshness !== null;
      case "location":
        return filters.countries.length > 0 || filters.cities.length > 0;
      case "work_mode":
        return filters.workModes.length > 0;
      case "salary":
        return filters.minSalary !== null;
      case "company":
        return filters.companies.length > 0;
      case "trust":
        return filters.trustStatuses.length > 0;
      case "application_status":
        return filters.applicationStatuses.length > 0;
      case "source":
        return filters.sources.length > 0;
      // employment_type and seniority have no backing column, so no value in
      // them can narrow anything and neither is ever counted as active.
      case "employment_type":
      case "seniority":
        return false;
    }
  }).length;
}

/**
 * The minimal builder surface these functions need.
 *
 * Declared structurally rather than importing supabase-js's builder type so the
 * predicates can be tested against a recording double without constructing a
 * client — the same split opportunityFilters.ts uses for the pure predicates.
 */
export interface FilterableQuery {
  in(column: string, values: readonly string[]): FilterableQuery;
  eq(column: string, value: unknown): FilterableQuery;
  gte(column: string, value: unknown): FilterableQuery;
  is(column: string, value: null): FilterableQuery;
  or(filter: string): FilterableQuery;
  not(column: string, operator: string, value: unknown): FilterableQuery;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): FilterableQuery;
}

/**
 * PostgREST in-list literal. Values are double-quoted because a company name can
 * contain a comma, which is the list separator — an unquoted "Acme, Inc" would
 * silently become two list entries and match neither.
 */
function inList(values: readonly string[]): string {
  return "(" + values.map((value) => '"' + value.replace(/"/g, '\\"') + '"').join(",") + ")";
}

export function freshnessCutoff(value: FreshnessValue, now: Date = new Date()): string {
  const window = FRESHNESS_WINDOWS.find((entry) => entry.value === value);
  const days = window?.days ?? 7;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Applies every available filter. Unavailable fields are ignored rather than
 * approximated: the UI disables them, and silently translating "senior" into a
 * title substring match here would make the disabled control look broken rather
 * than unavailable.
 */
export function applyOpportunityFilters<Q extends FilterableQuery>(
  query: Q,
  filters: OpportunityFilters,
  now: Date = new Date(),
): Q {
  let next = query;

  if (filters.freshness !== null) {
    next = next.gte("discovered_at", freshnessCutoff(filters.freshness, now)) as Q;
  }

  if (filters.countries.length > 0) {
    next = next.in("country", filters.countries) as Q;
  }
  if (filters.cities.length > 0) {
    next = next.in("city", filters.cities) as Q;
  }

  if (filters.workModes.length > 0) {
    next = next.in("remote_type", filters.workModes) as Q;
  }

  if (filters.minSalary !== null) {
    // salary_max, not salary_min: a range of 70k-90k satisfies an 80k floor, and
    // requiring the BOTTOM of the range to clear the floor would hide it.
    next = next.gte("salary_max", filters.minSalary) as Q;
    if (filters.minSalaryCurrency !== null) {
      // Comparing across currencies without a conversion would order and filter
      // by numbers that are not the same unit.
      next = next.eq("currency", filters.minSalaryCurrency) as Q;
    }
  }

  if (filters.companies.length > 0) {
    next = next.in("company_name", filters.companies) as Q;
  }

  if (filters.trustStatuses.length > 0) {
    next = next.in("trust_status", filters.trustStatuses) as Q;
  }

  if (filters.sources.length > 0) {
    next = next.in("source_code", filters.sources) as Q;
  }

  if (filters.applicationStatuses.length > 0) {
    // "Not applied" is attempt_status IS NULL, which an in-list cannot express.
    const wantsNone = filters.applicationStatuses.includes("none");
    const named = filters.applicationStatuses.filter((status) => status !== "none");

    if (wantsNone && named.length > 0) {
      next = next.or("attempt_status.is.null,attempt_status.in." + inList(named)) as Q;
    } else if (wantsNone) {
      next = next.is("attempt_status", null) as Q;
    } else {
      next = next.in("attempt_status", named) as Q;
    }
  }

  return next;
}

/**
 * Applies the standing exclusions from the profile.
 *
 * Separate from applyOpportunityFilters because these are not filters: they have
 * no control in the bar, they apply to every query including the first, and a
 * candidate cannot turn them off for one search without editing their profile —
 * which is what "excluded" is supposed to mean.
 *
 * Returns the list of exclusions that could NOT be applied, so the caller can
 * report them rather than implying they took effect.
 */
export function applyPreferenceExclusions<Q extends FilterableQuery>(
  query: Q,
  preferences: CandidatePreferences | null,
): { query: Q; unapplied: string[] } {
  if (!preferences) {
    return { query, unapplied: [] };
  }

  let next = query;
  const unapplied: string[] = [];

  const valuesFor: Record<string, string[]> = {
    excluded_companies: preferences.excludedCompanies ?? [],
    // No column on the view carries an industry: company_profiles.industry is
    // not exposed, so this exclusion is reported as unapplied rather than
    // silently doing nothing.
    excluded_industries: preferences.excludedIndustries ?? [],
  };

  const viewColumns = new Set(VACANCY_FILTERS.flatMap((spec) => spec.columns));

  for (const exclusion of PREFERENCE_EXCLUSIONS) {
    const values = valuesFor[exclusion.id] ?? [];
    if (values.length === 0) {
      continue;
    }

    if (!viewColumns.has(exclusion.column)) {
      unapplied.push(exclusion.label);
      continue;
    }

    next = next.not(exclusion.column, "in", inList(values)) as Q;
  }

  return { query: next, unapplied };
}

/** Applies a sort. An unavailable sort falls back to the default rather than ordering arbitrarily. */
export function applyOpportunitySort<Q extends FilterableQuery>(
  query: Q,
  sortId: SortId = DEFAULT_SORT,
): { query: Q; applied: SortId } {
  const requested = SORT_FIELDS_BY_ID[sortId];
  const effective = requested.orderBy.length > 0 ? requested : SORT_FIELDS_BY_ID[DEFAULT_SORT];

  let next = query;
  for (const clause of effective.orderBy) {
    next = next.order(clause.column, { ascending: clause.ascending, nullsFirst: clause.nullsFirst }) as Q;
  }

  return { query: next, applied: effective.id };
}

/**
 * The feed's target-role relevance filter.
 *
 * WHY IT LIVES HERE AND NOT IN SQL. The relevance rule is the tokenized matcher
 * in lib/roleTaxonomy.ts — the same one the Target Roles search uses — and that
 * rule is not expressible as a PostgREST clause without inventing a second,
 * different matching system (a raw ilike on the title would treat "end" as a hit
 * for "Backend"). This module owns the feed's query shape, so the row filter
 * belongs beside it.
 *
 * IT FILTERS THE FETCHED PAGE, SO CALLERS MUST PAGE ON RAW ROWS. Callers keep
 * the unfiltered page in state and filter only what they render; the offset then
 * still counts database rows, and a filtered page cannot re-read or skip rows.
 *
 * NO TARGET ROLES MEANS NO FILTER — the existing product behaviour, where a
 * candidate who has not chosen roles sees the whole verified feed. The readiness
 * gate, not this filter, is what asks them to choose.
 */
export function filterOpportunitiesByRoleRelevance<T extends { title: string }>(
  opportunities: readonly T[],
  preferences: SearchPreferences | null,
): T[] {
  if (!preferences || preferences.targetRoles.length === 0) {
    return [...opportunities];
  }

  return opportunities.filter((opportunity) => matchesAnyTargetRole(opportunity.title, preferences.targetRoles));
}

/**
 * The standing constraints SearchPreferences puts on every feed query, as
 * PostgREST clauses: work mode, salary floor and name exclusions.
 *
 * THIS IS THE OPTIMISATION HALF OF THE SAME RULE. Everything applied here is
 * also checkable by the ledger below, which is what keeps the by-id path (a
 * freshly discovered vacancy is fetched with .in("id", ...), not through these
 * clauses) consistent with the paged one. The clauses exist so the database
 * does not send rows we already know we do not want.
 *
 * Returns the constraints that could NOT be expressed, so the caller can report
 * them rather than implying they took effect — excluded industries still have no
 * column on the view.
 */
export function applySearchPreferenceConstraints<Q extends FilterableQuery>(
  query: Q,
  preferences: SearchPreferences | null,
): { query: Q; unapplied: string[] } {
  if (!preferences) {
    return { query, unapplied: [] };
  }

  let next = query;

  // A concrete work mode is a hard constraint; null ("not stated") and "any"
  // constrain nothing. A listing whose remote_type is NULL is excluded by the
  // in-list, which is the documented consequence of choosing a mode.
  if (preferences.workMode === "remote" || preferences.workMode === "hybrid" || preferences.workMode === "on_site") {
    next = next.in("remote_type", [preferences.workMode]) as Q;
  }

  // salary_max, not salary_min, so a range reaching the floor qualifies. The
  // currency equality stops two currencies being compared as one unit; the
  // builder guarantees a currency whenever a floor survives sanitisation.
  if (preferences.salary.min !== null && preferences.salary.currency !== null) {
    next = next.gte("salary_max", preferences.salary.min) as Q;
    next = next.eq("currency", preferences.salary.currency) as Q;
  }

  // Name exclusions reuse the existing standing-exclusion builder, so the
  // quoting and the "no industry column on the view" reporting stay in one place.
  const exclusions = applyPreferenceExclusions(next, {
    ...EMPTY_PREFERENCES,
    excludedCompanies: preferences.exclusions.companies,
    excludedIndustries: preferences.exclusions.industries,
  });

  return { query: exclusions.query, unapplied: exclusions.unapplied };
}

/** The job attributes the feed ledger judges. OpportunitySummary satisfies it. */
export interface SearchPreferenceJob {
  title: string;
  companyName: string | null;
  remoteType: string | null;
  salary: { max: number | null; currency: string | null };
}

/** The ledger is deliberately in the same gates shape as application_plans.gate_results. */
export type SearchPreferenceGates = Record<
  "role_match" | "excluded_company" | "work_mode" | "salary",
  { status: "pass" | "fail"; reasonCode?: string; detail?: Record<string, unknown> }
>;

export interface SearchPreferenceLedger {
  eligible: boolean;
  gates: SearchPreferenceGates;
}

/**
 * The structured, human-readable reason a job is filtered out — the feed's
 * eligibility ledger.
 *
 * WHY IT IS NOT JUST A DROP. The feed hides rows the candidate never sees, so a
 * silent exclusion is indistinguishable from a broken filter. Each check mirrors
 * one clause above one-for-one, so the profile the server filtered on and the
 * sentence the candidate reads come from the same object, and
 * ineligibilityReasonOf renders the first failing gate exactly as it does for an
 * application plan.
 */
export function evaluateSearchPreferenceEligibility(
  preferences: SearchPreferences,
  job: SearchPreferenceJob,
): SearchPreferenceLedger {
  const roleConstrained = preferences.targetRoles.length > 0;
  const rolePasses = !roleConstrained || matchesAnyTargetRole(job.title, preferences.targetRoles);

  const company = job.companyName === null ? null : job.companyName.trim().toLowerCase();
  const excludedCompany =
    company !== null &&
    company !== "" &&
    preferences.exclusions.companies.some((name) => name.toLowerCase() === company);

  const mode = preferences.workMode;
  const modeConstrained = mode === "remote" || mode === "hybrid" || mode === "on_site";
  const modePasses = !modeConstrained || job.remoteType === mode;

  const min = preferences.salary.min;
  const currency = preferences.salary.currency;
  const jobCurrency = job.salary.currency === null ? null : job.salary.currency.trim().toUpperCase();
  const salaryPasses =
    min === null ||
    (job.salary.max !== null && job.salary.max >= min && (currency === null || jobCurrency === currency));

  const gates: SearchPreferenceGates = {
    role_match: rolePasses
      ? { status: "pass" }
      : { status: "fail", reasonCode: "role_mismatch", detail: { targetRoles: preferences.targetRoles } },
    excluded_company: excludedCompany
      ? { status: "fail", reasonCode: "excluded_company", detail: { companyName: job.companyName } }
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
  };

  return { eligible: Object.values(gates).every((gate) => gate.status === "pass"), gates };
}
