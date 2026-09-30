import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSearchPreferences, type SearchPreferences } from "../../../shared/searchPreferences";
import { loadCandidatePreferences } from "./candidatePreferences";
import { listSelectedRoles } from "./candidateSelectedRoles";

/**
 * The thin client-side loader for the unified SearchPreferences object.
 *
 * It composes the two existing, already-tested read paths (candidate_preferences
 * and candidate_selected_roles) and hands the parsed values to the pure
 * buildSearchPreferences. It deliberately adds no query of its own: a second
 * select of the same row would be a second place the shape could drift.
 *
 * A failure of EITHER read is reported rather than half-built. Merging a
 * successful roles read with a failed preferences read would silently present
 * "no preferences" as the candidate's stated intent, which is exactly the
 * confusion this object exists to remove.
 */

export type LoadSearchPreferencesResult =
  | { kind: "success"; searchPreferences: SearchPreferences }
  | { kind: "error"; message: string };

export async function loadSearchPreferences(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<LoadSearchPreferencesResult> {
  const [preferencesResult, rolesResult] = await Promise.all([
    loadCandidatePreferences(client, candidateId),
    listSelectedRoles(client),
  ]);

  if (preferencesResult.kind === "error") {
    return { kind: "error", message: preferencesResult.message };
  }

  if (rolesResult.kind === "error") {
    return { kind: "error", message: rolesResult.message };
  }

  return {
    kind: "success",
    searchPreferences: buildSearchPreferences(
      preferencesResult.preferences,
      rolesResult.roles.map((role) => role.roleName),
    ),
  };
}
