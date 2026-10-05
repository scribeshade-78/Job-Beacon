import type { SupabaseClient } from "@supabase/supabase-js";
import {
  preferredQualifiers,
  qualifierPreferenceLabel,
} from "../../shared/candidateQualifiers.js";

/**
 * The candidate's saved raw intent, reduced to rankable PREFERENCES.
 *
 * WHY A SEPARATE LOADER. The role_name -> relevance rule is already loaded by
 * searchPreferences.ts and stays exactly as it is: canonical relevance is
 * REQUIRED. This adds the second, independent fact — what the candidate asked
 * for beyond the canonical role — which is a preference and never a filter.
 *
 * IT CANNOT MAKE ANYTHING INELIGIBLE. Nothing here is consulted by a gate's
 * pass/fail; the caller attaches it to a gate that always passes, so a missing
 * preference can never refuse a submission. That is the whole point of loading
 * it separately from the relevance rule.
 *
 * A QUERY ERROR THROWS, matching every other loader here: silently reporting no
 * preferences would look like "you never asked for Azure".
 */
export interface PreferredQualifierSummary {
  /** Rankable preference words, in the candidate's own order. */
  qualifiers: string[];
  /** Candidate-facing label ("Azure preferred"), or null when nothing is recorded. */
  label: string | null;
}

export const NO_PREFERRED_QUALIFIERS: PreferredQualifierSummary = { qualifiers: [], label: null };

interface SelectedRoleRow {
  role_name: string;
  raw_role_name: string | null;
}

export async function loadPreferredQualifiers(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<PreferredQualifierSummary> {
  const { data, error } = await client
    .from("candidate_selected_roles")
    .select("role_name, raw_role_name")
    .eq("candidate_id", candidateId);

  if (error) {
    throw error;
  }

  const qualifiers: string[] = [];

  for (const row of (data ?? []) as SelectedRoleRow[]) {
    for (const qualifier of preferredQualifiers(row.raw_role_name, row.role_name)) {
      if (!qualifiers.includes(qualifier)) {
        qualifiers.push(qualifier);
      }
    }
  }

  if (qualifiers.length === 0) {
    return NO_PREFERRED_QUALIFIERS;
  }

  return { qualifiers, label: qualifierPreferenceLabel(qualifiers) };
}
