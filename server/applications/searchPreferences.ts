import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSearchPreferences, type SearchPreferences } from "../../shared/searchPreferences.js";

/**
 * The service-role loader for the unified SearchPreferences object.
 *
 * THE SERVER NEVER TRUSTS A CLIENT-PROVIDED FLAG. evaluateEligibilityGates calls
 * this with the authenticated candidate's own id, and it reads
 * candidate_preferences and candidate_selected_roles itself — the same two
 * tables the browser loader reads, through the same pure builder, so the two
 * sides cannot disagree about what the candidate asked for.
 *
 * A query error THROWS rather than soft-failing. Every other gate in this module
 * propagates its query error, and turning a database outage into a structured
 * refusal would tell the candidate their preferences were the reason when the
 * truth is that we could not read them.
 */

interface PreferenceRow {
  preferred_countries: string[] | null;
  preferred_cities: string[] | null;
  remote_preference: string | null;
  employment_types: string[] | null;
  min_salary: number | null;
  min_salary_currency: string | null;
  open_to_any_location: boolean | null;
  excluded_companies: string[] | null;
  excluded_industries: string[] | null;
}

export async function loadSearchPreferencesForCandidate(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<SearchPreferences> {
  const [preferenceResult, roleResult] = await Promise.all([
    client
      .from("candidate_preferences")
      .select(
        "preferred_countries, preferred_cities, remote_preference, employment_types, min_salary, min_salary_currency, open_to_any_location, excluded_companies, excluded_industries",
      )
      .eq("candidate_id", candidateId)
      .maybeSingle(),
    client.from("candidate_selected_roles").select("role_name").eq("candidate_id", candidateId),
  ]);

  if (preferenceResult.error) {
    throw preferenceResult.error;
  }
  if (roleResult.error) {
    throw roleResult.error;
  }

  const row = (preferenceResult.data ?? null) as PreferenceRow | null;
  const roleNames = ((roleResult.data ?? []) as Array<{ role_name: string }>).map((entry) => entry.role_name);

  return buildSearchPreferences(
    row
      ? {
          preferredCountries: row.preferred_countries,
          preferredCities: row.preferred_cities,
          remotePreference: row.remote_preference,
          employmentTypes: row.employment_types,
          minSalary: row.min_salary,
          minSalaryCurrency: row.min_salary_currency,
          openToAnyLocation: row.open_to_any_location,
          excludedCompanies: row.excluded_companies,
          excludedIndustries: row.excluded_industries,
        }
      : null,
    roleNames,
  );
}
