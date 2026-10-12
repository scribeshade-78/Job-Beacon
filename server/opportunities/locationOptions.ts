import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The location values a candidate can actually choose from.
 *
 * DERIVED FROM DATA, NOT FROM A LIST WE MAINTAIN. Adzuna serves 19 markets and no
 * other source carries a structured country, so a hardcoded ISO list would offer
 * countries that CANNOT return a single job - which is exactly the defect the old
 * free-text location filter had. Anything offered here provably exists in the
 * catalogue.
 */
export interface LocationOptions {
  /** ISO-2 codes, upper-case, as stored on vacancies. */
  countries: string[];
  /** City or administrative area names, as stored on vacancies. */
  cities: string[];
}

/**
 * Anything the UI cannot use is dropped rather than repaired.
 *
 * A BLANK OPTION IS WORSE THAN A MISSING ONE: it renders as an unnamed row that
 * selects a value matching nothing, which is the silent no-op this whole change
 * exists to remove. The RPC already filters NULL and blank, so this is the second
 * line of defence at the boundary where data becomes interface.
 */
function usableStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

export async function loadLocationOptions(client: SupabaseClient): Promise<LocationOptions> {
  const { data, error } = await client.rpc("vacancy_location_options");

  // THROWN, NOT SWALLOWED. "We could not read the options" and "there are no options"
  // are different statements, and returning empty lists here would tell a candidate
  // their country is unavailable when in fact the query failed.
  if (error) {
    throw new Error(
      "Location options read failed: " + (error instanceof Error ? error.message : JSON.stringify(error)),
    );
  }

  const raw = (data ?? {}) as { countries?: unknown; cities?: unknown };

  return {
    countries: usableStrings(raw.countries),
    cities: usableStrings(raw.cities),
  };
}
