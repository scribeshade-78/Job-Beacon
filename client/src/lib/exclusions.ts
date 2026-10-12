import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The four PRD-named exclusion categories (PRD 31: "staffing agencies,
 * contract roles, relocation ... and sensitive sectors"). Salary is
 * deliberately excluded — see the migration comment for why. Whether any
 * of these are on by default is an explicit founder decision PRD 31 leaves
 * open, so nothing is pre-selected here; the candidate opts in.
 */
export const EXCLUSION_CATEGORIES = [
  "staffing_agencies",
  "contract_roles",
  "relocation_required",
  "sensitive_sectors",
] as const;

export type ExclusionCategory = (typeof EXCLUSION_CATEGORIES)[number];

const GENERIC_FAILURE_MESSAGE = "Could not update your exclusions. Please try again.";

export type ListExclusionsResult =
  | { kind: "success"; categories: ExclusionCategory[] }
  | { kind: "error"; message: string };

export async function listExclusions(
  client: Pick<SupabaseClient, "from">,
): Promise<ListExclusionsResult> {
  try {
    const { data, error } = await client.from("candidate_exclusions").select("category");

    if (error || !data) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return { kind: "success", categories: data.map((row) => row.category as ExclusionCategory) };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

export type SetExclusionResult = { kind: "success" } | { kind: "error"; message: string };

const POSTGRES_UNIQUE_VIOLATION = "23505";

/**
 * Toggles one category on (insert) or off (delete) for the caller's own
 * profile. Turning on a category that's already on is treated as success
 * (23505), same idempotent-on-duplicate pattern as ensureCandidateProfile.
 */
export async function setExclusion(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
  category: ExclusionCategory,
  enabled: boolean,
): Promise<SetExclusionResult> {
  try {
    if (enabled) {
      const { error } = await client
        .from("candidate_exclusions")
        .insert({ candidate_id: candidateId, category });

      if (error && error.code !== POSTGRES_UNIQUE_VIOLATION) {
        return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
      }

      return { kind: "success" };
    }

    const { error } = await client
      .from("candidate_exclusions")
      .delete()
      .eq("candidate_id", candidateId)
      .eq("category", category);

    if (error) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}
