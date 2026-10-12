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
 * Idempotent create-if-missing for the caller's own candidate_profiles row.
 * Plain INSERT only — never upsert/update, since the table has no mutable
 * field yet. A 23505 unique-violation means the row already exists, which
 * is the expected steady-state outcome on every sign-in after the first,
 * not a failure. RLS (not this function) is what actually enforces the
 * supplied id can only ever be the caller's own — a client bug sending the
 * wrong id is rejected by the database, not by anything trusted here.
 * Never returns or logs the raw Postgres/Supabase error, nor a thrown
 * network-layer error — only a generic, typed retryable failure either way.
 */
export async function ensureCandidateProfile(
  client: Pick<SupabaseClient, "from">,
  userId: string,
): Promise<EnsureProfileResult> {
  let error: { code?: string } | null;

  try {
    ({ error } = await client.from("candidate_profiles").insert({ id: userId }));
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
