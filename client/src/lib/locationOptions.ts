import { getSupabaseBrowserClient } from "./supabaseClient";

/**
 * The location values the pickers offer, read from the vacancies table by the server.
 *
 * DYNAMIC BECAUSE A HARDCODED LIST LIES. Only Adzuna returns a structured country, and
 * it serves 19 markets; a picker built from every ISO code would offer countries that
 * cannot return a single job. Whatever this returns provably exists in the catalogue.
 */
export interface LocationOptions {
  countries: string[];
  cities: string[];
}

function usableStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

export async function fetchLocationOptions(fetchImpl: typeof fetch = fetch): Promise<LocationOptions> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  const accessToken = data.session?.access_token;

  if (!accessToken) {
    throw new Error("Not signed in.");
  }

  const response = await fetchImpl("/api/opportunities/location-options", {
    headers: { Authorization: "Bearer " + accessToken },
  });

  // THROWN, NOT COLLAPSED INTO EMPTY LISTS. An empty picker and a failed request look
  // identical on screen, and only one of them means "we have no coverage there yet".
  if (!response.ok) {
    throw new Error("Could not load location options (HTTP " + response.status + ").");
  }

  const body = (await response.json()) as { countries?: unknown; cities?: unknown };

  return {
    countries: usableStrings(body.countries),
    cities: usableStrings(body.cities),
  };
}
