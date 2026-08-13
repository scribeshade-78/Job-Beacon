import type { SupabaseClient } from "@supabase/supabase-js";

const GENERIC_FAILURE_MESSAGE = "Could not sign out other sessions. Please try again.";

export type RevokeOtherSessionsResult = { kind: "success" } | { kind: "error"; message: string };

/**
 * Revokes every session for this account except the current one (PRD
 * 25.1: "Session revocation"). Uses GoTrue's own scope:'others' sign-out,
 * which only needs the caller's own access token — no service-role key or
 * server-side admin endpoint required. Full "security history" (a
 * device/IP list) would need the Admin API, which is a separate,
 * not-yet-authorized architectural decision — see the R1 completion
 * report.
 */
export async function revokeOtherSessions(
  client: Pick<SupabaseClient, "auth">,
): Promise<RevokeOtherSessionsResult> {
  try {
    const { error } = await client.auth.signOut({ scope: "others" });

    if (error) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}
