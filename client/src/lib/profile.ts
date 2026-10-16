import type { SupabaseClient } from "@supabase/supabase-js";

export type EnsureProfileResult =
  | { kind: "ready" }
  | { kind: "error"; message: string };

const POSTGRES_UNIQUE_VIOLATION = "23505";

// Shared by both failure paths (a resolved non-23505 Postgres error, and a
// thrown/rejected network error) — never the raw error, message, code,
// stack, token, or session.
const GENERIC_FAILURE_MESSAGE = "Could not set up your profile. Please try again.";

/**
 * Create-if-missing for the caller's own candidate_profiles row.
 *
 * ON CONFLICT DO NOTHING, NOT A PLAIN INSERT. The first version inserted and treated a 23505
 * unique violation as success. That is logically idempotent but not operationally: every
 * sign-in after the first produced a guaranteed HTTP 409, which the BROWSER reports as a
 * console error even though this function handles it, plus a wasted round trip every time.
 * ignoreDuplicates compiles to ON CONFLICT DO NOTHING — still create-only, performing no
 * UPDATE — so the reason this is not a mutating upsert still stands.
 *
 * THE 23505 BRANCH REMAINS AS A FALLBACK rather than as the mechanism: if anything strips the
 * Prefer header the request degrades to a plain INSERT, and a conflict there must still be a
 * success rather than a failed sign-in.
 *
 * RLS (not this function) is what actually enforces the supplied id can only ever be the
 * caller's own — a client bug sending the wrong id is rejected by the database, not by
 * anything trusted here. Never returns or logs the raw Postgres/Supabase error, nor a thrown
 * network-layer error — only a generic, typed retryable failure either way.
 */
export async function ensureCandidateProfile(
  client: Pick<SupabaseClient, "from">,
  userId: string,
): Promise<EnsureProfileResult> {
  let error: { code?: string } | null;

  try {
    ({ error } = await client
      .from("candidate_profiles")
      .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true }));
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }

  if (!error) {
    return { kind: "ready" };
  }

  if (error.code === POSTGRES_UNIQUE_VIOLATION) {
    return { kind: "ready" };
  }

  return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
}
