import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Auto-Apply preferences (Mini-Phase 1). Stored on candidate_profiles —
 * direct browser -> Supabase reads/writes scoped by RLS, the same shape as
 * lib/exclusions.ts and lib/candidateSelectedRoles.ts, so no Express route is
 * needed.
 *
 * SCOPE: record preference only. Nothing here is read by eligibilityGate.ts,
 * the application worker, or automation_authorizations — the columns persist
 * what the candidate chose and nothing acts on it yet.
 */

export const RESUME_OPTIMIZATION_LEVELS = ["off", "honest", "aggressive"] as const;

export type ResumeOptimizationLevel = (typeof RESUME_OPTIMIZATION_LEVELS)[number];

export interface ApplicationPreferences {
  resumeOptimizationLevel: ResumeOptimizationLevel;
  reviewBeforeSubmit: boolean;
}

/**
 * Must stay identical to the column defaults in
 * 20260917140000_candidate_application_preferences.sql. These are used only
 * for a profile row that does not exist yet; a row that does exist always
 * reports its stored values, never these.
 */
export const DEFAULT_APPLICATION_PREFERENCES: ApplicationPreferences = {
  resumeOptimizationLevel: "honest",
  reviewBeforeSubmit: true,
};

const GENERIC_LOAD_FAILURE_MESSAGE = "Could not load your application preferences. Please try again.";
const GENERIC_SAVE_FAILURE_MESSAGE = "Could not save your application preferences. Please try again.";

function isResumeOptimizationLevel(value: unknown): value is ResumeOptimizationLevel {
  return typeof value === "string" && (RESUME_OPTIMIZATION_LEVELS as readonly string[]).includes(value);
}

export type LoadApplicationPreferencesResult =
  | { kind: "success"; preferences: ApplicationPreferences }
  | { kind: "error"; message: string };

/**
 * candidate_profiles is keyed by the candidate's own auth id and its RLS
 * scopes SELECT to that row, so the id predicate here is belt-and-braces
 * rather than the security boundary.
 *
 * A missing row resolves to the documented defaults rather than an error:
 * the profile row is created on sign-in (lib/profile.ts) and App.tsx does not
 * mark the page ready until it exists, so this is defensive only — and the
 * column defaults are exactly what that row will contain once created, so
 * showing them is accurate rather than invented.
 */
export async function loadApplicationPreferences(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<LoadApplicationPreferencesResult> {
  try {
    const { data, error } = await client
      .from("candidate_profiles")
      .select("resume_optimization_level, review_before_submit")
      .eq("id", candidateId)
      .maybeSingle();

    if (error) {
      return { kind: "error", message: GENERIC_LOAD_FAILURE_MESSAGE };
    }

    if (!data) {
      return { kind: "success", preferences: { ...DEFAULT_APPLICATION_PREFERENCES } };
    }

    const row = data as { resume_optimization_level: unknown; review_before_submit: unknown };

    return {
      kind: "success",
      preferences: {
        // A stored value outside the known set (a level added by a later
        // migration, read by an older bundle) is surfaced as the default
        // rather than rendered as a radio option that does not exist.
        resumeOptimizationLevel: isResumeOptimizationLevel(row.resume_optimization_level)
          ? row.resume_optimization_level
          : DEFAULT_APPLICATION_PREFERENCES.resumeOptimizationLevel,
        reviewBeforeSubmit:
          typeof row.review_before_submit === "boolean"
            ? row.review_before_submit
            : DEFAULT_APPLICATION_PREFERENCES.reviewBeforeSubmit,
      },
    };
  } catch {
    return { kind: "error", message: GENERIC_LOAD_FAILURE_MESSAGE };
  }
}

export type SaveApplicationPreferencesResult = { kind: "success" } | { kind: "error"; message: string };

/**
 * Both writers share this shape because the failure mode is the same and is
 * easy to get wrong: an UPDATE matching zero rows is NOT a Postgres error in
 * PostgREST, it is a silent 204. Without .select() a candidate whose profile
 * row is missing would be told their preference saved when nothing was
 * written. Same .select()-checked pattern as lib/factConfirmations.ts.
 */
async function updatePreferenceColumn(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
  patch: Record<string, unknown>,
): Promise<SaveApplicationPreferencesResult> {
  try {
    const { data, error } = await client
      .from("candidate_profiles")
      .update(patch)
      .eq("id", candidateId)
      .select("id");

    if (error || !data || data.length === 0) {
      return { kind: "error", message: GENERIC_SAVE_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_SAVE_FAILURE_MESSAGE };
  }
}

export function updateResumeOptimizationLevel(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
  level: ResumeOptimizationLevel,
): Promise<SaveApplicationPreferencesResult> {
  return updatePreferenceColumn(client, candidateId, { resume_optimization_level: level });
}

export function updateReviewBeforeSubmit(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
  reviewBeforeSubmit: boolean,
): Promise<SaveApplicationPreferencesResult> {
  return updatePreferenceColumn(client, candidateId, { review_before_submit: reviewBeforeSubmit });
}
