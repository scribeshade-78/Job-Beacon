/**
 * Task I — the single declaration of what can be filtered and sorted, shared by
 * the client and the server.
 *
 * WHY THIS FILE EXISTS. The brief names 10 vacancy filters and 6 sorts. Not all
 * of them are backed by data, and the honest response is neither to invent the
 * missing columns nor to quietly drop the fields: it is to declare, in ONE place
 * that both ends of the app read, which query column each field reads and — where
 * there is none — exactly why there is none.
 *
 * Three sorts and two filters have no backing column today. That is a fact about
 * the schema, and this file is where it is recorded so the UI can disable the
 * control with the real reason rather than silently returning everything, which
 * is the failure mode task F already removed once ("an active-looking filter that
 * silently returns everything is worse than an obviously unavailable one").
 *
 * THE SERVER AND CLIENT CANNOT DRIFT: adding a field means adding one entry here,
 * and the compiler then requires both the query builder and the filter bar to
 * handle it.
 */

/** A value that seeds a filter's initial state from the candidate's own profile. */
export type PreferenceKey =
  | "preferredCountries"
  | "preferredCities"
  | "remotePreference"
  | "employmentTypes"
  | "minSalary"
  | "willingToRelocate"
  | "excludedCompanies"
  | "excludedIndustries";

export type FilterFieldId =
  | "freshness"
  | "location"
  | "work_mode"
  | "employment_type"
  | "salary"
  | "seniority"
  | "company"
  | "trust"
  | "application_status"
  | "source";

export interface FilterFieldSpec {
  id: FilterFieldId;
  label: string;
  /**
   * View column(s) the filter reads. An EMPTY array means nothing backs it and
   * unavailableReason says why; a non-empty array means it is applied.
   */
  columns: string[];
  unavailableReason: string | null;
  /** Which preference seeds this filter's starting value, when one does. */
  inheritsFrom: PreferenceKey | null;
  /** Explains a limitation that survives even though the filter works. */
  caveat: string | null;
}

/**
 * The 10 vacancy filters, in the order they should appear.
 *
 * "columns" names columns on public.candidate_opportunities, which is what the
 * Opportunities panel reads. A filter whose column exists there is applied
 * server-side; one whose columns array is empty is rendered disabled.
 */
export const VACANCY_FILTERS: readonly FilterFieldSpec[] = [
  {
    id: "freshness",
    label: "Freshness",
    columns: ["discovered_at"],
    unavailableReason: null,
    inheritsFrom: null,
    caveat: null,
  },
  {
    id: "location",
    label: "Location",
    columns: ["country", "city", "region"],
    unavailableReason: null,
    inheritsFrom: "preferredCountries",
    caveat: null,
  },
  {
    id: "work_mode",
    label: "Work mode",
    columns: ["remote_type"],
    unavailableReason: null,
    inheritsFrom: "remotePreference",
    caveat:
      "Only 47 of 217 listings state a work mode at all. Selecting one therefore hides every listing that stayed silent, which is deliberate — a listing that never said 'remote' is not evidence that it is.",
  },
  {
    id: "employment_type",
    label: "Employment type",
    columns: [],
    unavailableReason:
      "We can't filter by employment type yet: too few listings say whether they are full-time or contract. Your preference is saved to your profile but is not applied to searches.",
    inheritsFrom: "employmentTypes",
    caveat: null,
  },
  {
    id: "salary",
    label: "Salary",
    columns: ["salary_min", "salary_max", "currency"],
    unavailableReason: null,
    inheritsFrom: "minSalary",
    caveat:
      "Listings don't say whether a pay figure is per year, per day or per hour, so we can't confirm a salary is annual. We compare the advertised figures directly, and only within the same currency.",
  },
  {
    id: "seniority",
    label: "Seniority",
    columns: [],
    unavailableReason:
      "We can't filter by seniority yet. Job titles come straight from the original listing as free text, so reading 'senior' or 'junior' into them would be a guess presented as a filter.",
    inheritsFrom: null,
    caveat: null,
  },
  {
    id: "company",
    label: "Company",
    columns: ["company_name"],
    unavailableReason: null,
    // NOT seeded from excludedCompanies. An exclusion is a standing constraint
    // that is always applied, not a starting value the candidate can edit for
    // one search — seeding this filter from it would present "companies I never
    // want to see" as "companies I am searching for", which is the opposite.
    inheritsFrom: null,
    caveat: null,
  },
  {
    id: "trust",
    label: "Trust",
    columns: ["trust_status"],
    unavailableReason: null,
    inheritsFrom: null,
    caveat: null,
  },
  {
    id: "application_status",
    label: "Application status",
    columns: ["attempt_status"],
    unavailableReason: null,
    inheritsFrom: null,
    caveat: null,
  },
  {
    id: "source",
    label: "Source",
    columns: ["source_code"],
    unavailableReason: null,
    inheritsFrom: null,
    caveat: null,
  },
];

export type SortId =
  | "best_match"
  | "newest"
  | "highest_salary"
  | "company_rating"
  | "work_life_balance"
  | "recently_verified";

export interface SortSpec {
  id: SortId;
  label: string;
  /** Order-by clauses applied in sequence. Empty means unavailable. */
  orderBy: Array<{ column: string; ascending: boolean; nullsFirst: boolean }>;
  unavailableReason: string | null;
  caveat: string | null;
}

/**
 * The 6 sorts.
 *
 * Every available sort ends with last_seen_at as a tiebreak, so rows with equal
 * primary keys have a stable order across pages — without it, "Load more" can
 * repeat a row it already showed.
 */
export const VACANCY_SORTS: readonly SortSpec[] = [
  {
    id: "best_match",
    label: "Best match",
    orderBy: [
      { column: "priority_score", ascending: false, nullsFirst: false },
      { column: "last_seen_at", ascending: false, nullsFirst: false },
      // Deterministic final tie-break: without it "Load more" can repeat or skip
      // a row whose score and last_seen_at are equal. The ranked view prepends
      // matched_qualifier_count ahead of this when ranking is current.
      { column: "id", ascending: true, nullsFirst: false },
    ],
    unavailableReason: null,
    caveat: "Listings we haven't scored yet sort last rather than being hidden: fit analysis hasn't run for them.",
  },
  {
    id: "newest",
    label: "Newest",
    orderBy: [
      { column: "discovered_at", ascending: false, nullsFirst: false },
      { column: "last_seen_at", ascending: false, nullsFirst: false },
    ],
    unavailableReason: null,
    caveat: null,
  },
  {
    id: "highest_salary",
    label: "Highest salary",
    orderBy: [
      { column: "salary_max", ascending: false, nullsFirst: false },
      { column: "last_seen_at", ascending: false, nullsFirst: false },
    ],
    unavailableReason: null,
    caveat:
      "Sorts the advertised figure. Every listing is in US dollars today, so the comparison is meaningful; a second currency would not be comparable because we don't convert between them.",
  },
  {
    id: "company_rating",
    label: "Company rating",
    orderBy: [],
    unavailableReason:
      "We don't show company ratings yet, so there is no rating to sort by.",
    caveat: null,
  },
  {
    id: "work_life_balance",
    label: "Work-life balance",
    orderBy: [],
    unavailableReason:
      "We don't have an overall company rating yet — individual reviews aren't combined into a single score. Sorting by review scores would rank a company on whichever single review happened to load.",
    caveat: null,
  },
  {
    id: "recently_verified",
    label: "Recently verified",
    orderBy: [],
    unavailableReason:
      "We can't sort by verification time yet — that information isn't available to your account.",
    caveat: null,
  },
];

/**
 * Standing exclusions taken from the candidate's profile and applied to EVERY
 * query, with no UI control in the filter bar.
 *
 * These are the third category, and separating them is what keeps the UI clean:
 * a preference (what you want), a filter (what you are looking at now) and an
 * exclusion (what must never appear). An exclusion has no on-the-fly equivalent
 * because "hide this for one search" is a filter, and the candidate can already
 * type a company into the company filter.
 */
export interface ExclusionSpec {
  id: "excluded_companies" | "excluded_industries";
  label: string;
  column: string;
  preferenceKey: PreferenceKey;
}

export const PREFERENCE_EXCLUSIONS: readonly ExclusionSpec[] = [
  {
    id: "excluded_companies",
    label: "Excluded companies",
    column: "company_name",
    preferenceKey: "excludedCompanies",
  },
  {
    id: "excluded_industries",
    label: "Excluded industries",
    // company_profiles.industry is the only industry data in the schema, and it
    // is NOT on the view: applying this needs a join the view does not expose,
    // so it is declared here and reported as unapplied rather than silently
    // dropping every row whose industry is unknown.
    column: "company_industry",
    preferenceKey: "excludedIndustries",
  },
];

export const FILTER_FIELDS_BY_ID: Record<FilterFieldId, FilterFieldSpec> = Object.fromEntries(
  VACANCY_FILTERS.map((spec) => [spec.id, spec]),
) as Record<FilterFieldId, FilterFieldSpec>;

export const SORT_FIELDS_BY_ID: Record<SortId, SortSpec> = Object.fromEntries(
  VACANCY_SORTS.map((spec) => [spec.id, spec]),
) as Record<SortId, SortSpec>;

export const DEFAULT_SORT: SortId = "best_match";

export function isFilterAvailable(id: FilterFieldId): boolean {
  return FILTER_FIELDS_BY_ID[id].columns.length > 0;
}

export function isSortAvailable(id: SortId): boolean {
  return SORT_FIELDS_BY_ID[id].orderBy.length > 0;
}

/** Freshness windows, in days. Bounds discovered_at. */
export const FRESHNESS_WINDOWS = [
  { value: "1", label: "Last 24 hours", days: 1 },
  { value: "3", label: "Last 3 days", days: 3 },
  { value: "7", label: "Last 7 days", days: 7 },
  { value: "30", label: "Last 30 days", days: 30 },
] as const;

export type FreshnessValue = (typeof FRESHNESS_WINDOWS)[number]["value"];

export const REMOTE_PREFERENCE_OPTIONS = [
  { value: "remote", label: "Remote only" },
  { value: "hybrid", label: "Hybrid" },
  { value: "on_site", label: "On-site" },
  { value: "any", label: "Any" },
] as const;

export type RemotePreferenceValue = (typeof REMOTE_PREFERENCE_OPTIONS)[number]["value"];

export const EMPLOYMENT_TYPE_OPTIONS = [
  { value: "full_time", label: "Full-time" },
  { value: "part_time", label: "Part-time" },
  { value: "contract", label: "Contract" },
  { value: "internship", label: "Internship" },
  { value: "temporary", label: "Temporary" },
] as const;

export type EmploymentTypeValue = (typeof EMPLOYMENT_TYPE_OPTIONS)[number]["value"];

export const WORK_AUTHORIZATION_OPTIONS = [
  { value: "citizen", label: "Citizen of the hiring country" },
  { value: "permanent_resident", label: "Permanent resident" },
  { value: "visa_required", label: "Requires visa sponsorship" },
  { value: "other", label: "Other / prefer not to say" },
] as const;

export type WorkAuthorizationValue = (typeof WORK_AUTHORIZATION_OPTIONS)[number]["value"];

/** The trust values the view exposes. */
export const TRUST_FILTER_OPTIONS = [
  { value: "VERIFIED", label: "Verified" },
  { value: "VERIFIED_INCOMPLETE", label: "Verified (incomplete)" },
  { value: "UNDER_REVIEW", label: "Under review" },
] as const;

/** attempt_status is null for a vacancy the candidate has never applied to. */
export const APPLICATION_STATUS_FILTER_OPTIONS = [
  { value: "none", label: "Not applied" },
  { value: "pending", label: "Pending" },
  { value: "leased", label: "In progress" },
  { value: "succeeded", label: "Applied" },
  { value: "failed", label: "Failed" },
  { value: "action_required", label: "Action required" },
  { value: "cancelled", label: "Cancelled" },
] as const;
