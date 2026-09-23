import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Part 3 of the multi-source intake work — the candidate context the credentialed
 * aggregators need in order to be asked anything at all.
 *
 * WHY THIS IS A SEPARATE MODULE. Remotive needs nothing (it is a public browse
 * endpoint), Jooble needs keywords and a location, and Adzuna needs an ISO
 * country. Resolving that context means three reads across three tables, and it
 * belongs neither in the route (which would make the endpoint's body a query
 * plan) nor in an adapter (each would re-implement the same three reads, and
 * "what the candidate is looking for" is not a property of Jooble).
 *
 * EVERY FIELD IS OPTIONAL AND THAT IS THE POINT. A candidate who has selected no
 * roles, confirmed no location and stated no preference is not an error state —
 * they get whatever the sources that need no context can return, and the sources
 * that do need it are skipped with a reason the fan-out reports. This module's
 * job is to say what is known, never to insist that something is.
 */

export interface IntakeQueryContext {
  /** Every selected role, joined into ONE comma-separated string. See below. */
  keywords?: string;
  /** Where to search around. */
  location?: string;
  /** ISO-3166 alpha-2, lower-cased for direct use as Adzuna's URL path segment. */
  country?: string;
}

/**
 * Two letters and nothing else.
 *
 * Deliberately not a list of valid ISO codes: the question this answers is "did
 * the candidate write a code, or a name?", not "is this a real country". A name
 * like "India" or "United States" fails, which is the intended outcome — see
 * resolveCountry.
 */
const ISO_ALPHA2 = /^[A-Za-z]{2}$/;

/** First entry that is a non-blank string, or undefined. Blank entries are treated as absent. */
function firstNonBlank(values: readonly string[] | null | undefined): string | undefined {
  for (const value of values ?? []) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

/**
 * Decision 1: every selected role, joined into ONE comma-separated string.
 *
 * ONE STRING, ONE REQUEST. Jooble's free plan is a lifetime total of 500 requests
 * per key (docs/JOOBLE_INTEGRATION.md §1.3), so asking per role would spend a
 * candidate's entire budget in a handful of clicks. Returning a joined string
 * rather than an array is what makes a per-role loop impossible downstream
 * instead of merely discouraged — the array never leaves this function.
 *
 * Ordered by created_at so the string is stable across calls, which matters
 * because it is sent to an API and logged.
 */
async function loadRoleKeywords(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<string | undefined> {
  const { data, error } = await client
    .from("candidate_selected_roles")
    .select("role_name")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  const names = ((data ?? []) as Array<{ role_name: string }>)
    .map((row) => row.role_name.trim())
    .filter((name) => name.length > 0);

  return names.length > 0 ? names.join(", ") : undefined;
}

/**
 * Decision 2, primary source: the candidate's CONFIRMED location fact.
 *
 * Two-step query (facts, then the confirmations for those fact ids) — the same
 * shape generateResumePayload and evaluateVerifiedFacts use, and `corrected_value`
 * wins over `extracted_facts.fact_value` for the same reason it does there: a
 * location the candidate corrected must not be silently replaced by the raw
 * extraction. Only a CONFIRMED fact counts, because an unreviewed extraction is
 * not something to spend a third-party request on.
 *
 * The v0 fact vocabulary allows at most one location per extraction, but
 * re-extraction is documented to create duplicates (MP-F1's known limitation),
 * so more than one confirmed row is possible and the first is taken. The query
 * has no ordering clause because the schema provides none to order by that would
 * mean anything here.
 */
async function loadConfirmedLocation(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<string | undefined> {
  const { data: factRows, error: factError } = await client
    .from("extracted_facts")
    .select("id, fact_value")
    .eq("candidate_id", candidateId)
    .eq("fact_type", "location");

  if (factError) {
    throw factError;
  }

  const facts = (factRows ?? []) as Array<{ id: string; fact_value: string }>;

  if (facts.length === 0) {
    return undefined;
  }

  const { data: confirmationRows, error: confirmationError } = await client
    .from("fact_confirmations")
    .select("extracted_fact_id, corrected_value")
    .in(
      "extracted_fact_id",
      facts.map((fact) => fact.id),
    )
    .eq("status", "confirmed");

  if (confirmationError) {
    throw confirmationError;
  }

  const correctedValueByFactId = new Map(
    ((confirmationRows ?? []) as Array<{ extracted_fact_id: string; corrected_value: string | null }>).map((row) => [
      row.extracted_fact_id,
      row.corrected_value,
    ]),
  );

  const confirmed = facts
    .filter((fact) => correctedValueByFactId.has(fact.id))
    .map((fact) => (correctedValueByFactId.get(fact.id) ?? fact.fact_value).trim())
    .filter((value) => value.length > 0);

  return confirmed[0];
}

/**
 * Decision 3: the country is used ONLY when the preference is literally a
 * two-letter code.
 *
 * A country NAME IS NEVER CONVERTED INTO A CODE. "India" is not "in", and the
 * tempting lookup table is the dangerous part: Adzuna's country also silently
 * selects which national job market is searched, so a wrong or guessed code does
 * not fail loudly — it returns plausible listings for the wrong country. When
 * the preference is a name, the country is left undefined and Adzuna is skipped
 * with a reason the candidate can act on.
 *
 * Lower-cased because Adzuna's URL path segments are lower-case ("/jobs/gb/"),
 * and normalising here keeps the adapter from having to.
 */
function resolveCountry(preferredCountries: readonly string[] | null | undefined): string | undefined {
  const first = firstNonBlank(preferredCountries);

  if (!first || !ISO_ALPHA2.test(first)) {
    return undefined;
  }

  return first.toLowerCase();
}

/**
 * Reads everything the credentialed aggregators need, in the fixed fallback
 * order the product decided:
 *
 *   location: confirmed location fact -> preferred_cities[0] -> preferred_countries[0]
 *
 * A CONFIRMED FACT OUTRANKS A STATED PREFERENCE, deliberately. The fact is what
 * the candidate's resume says about where they are; the preference is what they
 * typed into a form about where they would like to be. Joining a search on the
 * wish rather than the fact is how a candidate in Bengaluru gets shown jobs in
 * Berlin and concludes the feature is broken.
 *
 * EMPTY IS NOT AN ERROR — every field is undefined when nothing is known, and the
 * caller passes that through. A THROWN QUERY ERROR IS NOT EMPTY, though: a
 * database failure propagates rather than being reported as "the candidate has
 * no roles". Collapsing the two would make a transient outage produce skip
 * reasons that blame the candidate's profile, which is both false and
 * unactionable.
 */
export async function loadIntakeQueryContext(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<IntakeQueryContext> {
  const keywords = await loadRoleKeywords(client, candidateId);

  const { data: preferenceRow, error: preferenceError } = await client
    .from("candidate_preferences")
    .select("preferred_cities, preferred_countries")
    .eq("candidate_id", candidateId)
    .maybeSingle();

  if (preferenceError) {
    throw preferenceError;
  }

  // No row is the normal state for a candidate who has never opened the
  // preferences form, not a missing-record error.
  const preferences = (preferenceRow ?? null) as {
    preferred_cities: string[] | null;
    preferred_countries: string[] | null;
  } | null;

  const confirmedLocation = await loadConfirmedLocation(client, candidateId);

  const location =
    confirmedLocation ??
    firstNonBlank(preferences?.preferred_cities) ??
    firstNonBlank(preferences?.preferred_countries);

  return {
    keywords,
    location,
    country: resolveCountry(preferences?.preferred_countries),
  };
}
