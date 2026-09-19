import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EmploymentTypeValue,
  RemotePreferenceValue,
  WorkAuthorizationValue,
} from "../../../shared/opportunityQuery";

/**
 * Task I — the durable half of the filtering architecture.
 *
 * Stored on candidate_preferences (PRD v3 §21.1 Candidate domain). Read and
 * written directly through the browser client, the same shape
 * applicationPreferences.ts uses for candidate_profiles: the table carries a
 * select-own / insert-own / update-own RLS policy keyed on auth.uid(), so the
 * database, not this module, is what guarantees a candidate cannot touch
 * somebody else's row.
 *
 * EVERY FIELD IS NULLABLE AND NULL MEANS "NOT STATED", which is deliberately not
 * the same as a negative answer. "I have not said whether I will relocate" and
 * "I will not relocate" lead to different matching behaviour, and collapsing
 * them into false would make the difference unrepresentable.
 */

export interface CandidatePreferences {
  preferredCountries: string[];
  preferredCities: string[];
  remotePreference: RemotePreferenceValue | null;
  employmentTypes: EmploymentTypeValue[];
  workAuthorization: WorkAuthorizationValue | null;
  requiresSponsorship: boolean | null;
  minSalary: number | null;
  minSalaryCurrency: string | null;
  willingToRelocate: boolean | null;
  excludedCompanies: string[];
  excludedIndustries: string[];
}

export const EMPTY_PREFERENCES: CandidatePreferences = {
  preferredCountries: [],
  preferredCities: [],
  remotePreference: null,
  employmentTypes: [],
  workAuthorization: null,
  requiresSponsorship: null,
  minSalary: null,
  minSalaryCurrency: null,
  willingToRelocate: null,
  excludedCompanies: [],
  excludedIndustries: [],
};

export type PreferencesResult =
  | { kind: "success"; preferences: CandidatePreferences | null }
  | { kind: "error"; message: string };

export type SavePreferencesResult =
  | { kind: "success"; preferences: CandidatePreferences }
  | { kind: "error"; message: string };

const SAVE_FAILURE = "Could not save your preferences. Please try again.";
const LOAD_FAILURE = "Could not load your preferences. Please try again.";

interface PreferenceRow {
  preferred_countries: string[] | null;
  preferred_cities: string[] | null;
  remote_preference: string | null;
  employment_types: string[] | null;
  work_authorization: string | null;
  requires_sponsorship: boolean | null;
  min_salary: number | null;
  min_salary_currency: string | null;
  willing_to_relocate: boolean | null;
  excluded_companies: string[] | null;
  excluded_industries: string[] | null;
}

function toPreferences(row: PreferenceRow): CandidatePreferences {
  return {
    preferredCountries: row.preferred_countries ?? [],
    preferredCities: row.preferred_cities ?? [],
    remotePreference: (row.remote_preference as RemotePreferenceValue | null) ?? null,
    employmentTypes: (row.employment_types ?? []) as EmploymentTypeValue[],
    workAuthorization: (row.work_authorization as WorkAuthorizationValue | null) ?? null,
    requiresSponsorship: row.requires_sponsorship,
    minSalary: row.min_salary,
    minSalaryCurrency: row.min_salary_currency,
    willingToRelocate: row.willing_to_relocate,
    excludedCompanies: row.excluded_companies ?? [],
    excludedIndustries: row.excluded_industries ?? [],
  };
}

export async function loadCandidatePreferences(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<PreferencesResult> {
  try {
    const { data, error } = await client
      .from("candidate_preferences")
      .select("preferred_countries, preferred_cities, remote_preference, employment_types, work_authorization, requires_sponsorship, min_salary, min_salary_currency, willing_to_relocate, excluded_companies, excluded_industries")
      .eq("candidate_id", candidateId)
      .maybeSingle();

    if (error) {
      return { kind: "error", message: LOAD_FAILURE };
    }

    // No row is the normal state for a candidate who has not opened the form,
    // and returning null rather than an empty object lets the caller distinguish
    // "never set" from "set to nothing".
    return { kind: "success", preferences: data ? toPreferences(data as PreferenceRow) : null };
  } catch {
    // LOAD wording, not SAVE wording. The two paths shared one constant until
    // Task I's UI work surfaced it: a failed READ told the candidate their
    // preferences could not be SAVED, which describes a problem they did not
    // have and a fix (press save again) that would not help.
    return { kind: "error", message: LOAD_FAILURE };
  }
}

/**
 * Writes the whole preference set.
 *
 * Upsert rather than update, because the row does not exist until the candidate
 * saves for the first time — an update would silently affect zero rows and the
 * form would appear to save while storing nothing. The candidate_id is supplied
 * rather than defaulted so the RLS with-check has something to compare.
 */
export async function saveCandidatePreferences(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
  preferences: CandidatePreferences,
): Promise<SavePreferencesResult> {
  // A salary floor with no currency is not a floor: 80000 means different things
  // in INR and USD, and the table CHECK refuses the combination. Failing here
  // with the reason beats a constraint violation the candidate cannot read.
  const minSalary = preferences.minSalary === null || preferences.minSalary === undefined
    ? null
    : preferences.minSalary;
  const currency = preferences.minSalaryCurrency?.trim().toUpperCase() ?? null;

  if (minSalary !== null && (currency === null || currency.length !== 3)) {
    return { kind: "error", message: "Choose a currency for your minimum salary." };
  }

  const payload = {
    candidate_id: candidateId,
    preferred_countries: preferences.preferredCountries,
    preferred_cities: preferences.preferredCities,
    remote_preference: preferences.remotePreference,
    employment_types: preferences.employmentTypes,
    work_authorization: preferences.workAuthorization,
    requires_sponsorship: preferences.requiresSponsorship,
    min_salary: minSalary,
    min_salary_currency: currency,
    willing_to_relocate: preferences.willingToRelocate,
    excluded_companies: preferences.excludedCompanies,
    excluded_industries: preferences.excludedIndustries,
    updated_at: new Date().toISOString(),
  };

  try {
    const { data, error } = await client
      .from("candidate_preferences")
      .upsert(payload, { onConflict: "candidate_id" })
      .select("preferred_countries, preferred_cities, remote_preference, employment_types, work_authorization, requires_sponsorship, min_salary, min_salary_currency, willing_to_relocate, excluded_companies, excluded_industries")
      .single();

    if (error || !data) {
      return { kind: "error", message: SAVE_FAILURE };
    }

    return { kind: "success", preferences: toPreferences(data as PreferenceRow) };
  } catch {
    return { kind: "error", message: SAVE_FAILURE };
  }
}

/**
 * Splits a comma or newline separated input into clean values.
 *
 * Shared by the excluded-companies and excluded-industries fields: both are
 * "type a list" inputs, and doing the split differently in each would let the
 * two disagree about whether "Acme, Inc" is one company or two.
 */
export function parseListInput(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
