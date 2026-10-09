/**
 * Phase 2c M6 - the client half of the discovery-surface ledger write.
 *
 * A ROUTE, NOT A BROWSER RPC. candidate_usage_events is service-role-only with no
 * candidate write path, so the client cannot insert into it and must not be able
 * to: this reports what the candidate was shown and lets the server decide. The
 * server takes the candidate id from the verified token, so a forged body can only
 * ever claim the caller's own surfaces.
 *
 * FIRE AND FORGET, and it swallows its own failures on purpose. This is accounting,
 * not the feed: a ledger write that fails must never turn a successful job list
 * into an error screen. The next read re-reports anything missed, and the unique
 * key makes that harmless.
 */

import { getSupabaseBrowserClient } from "./supabaseClient";

export async function reportDiscoverySurfaces(
  vacancyIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (vacancyIds.length === 0) {
    return;
  }

  try {
    const { data } = await getSupabaseBrowserClient().auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      return;
    }

    await fetchImpl("/api/usage/discovery-surface", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ vacancyIds }),
    });
  } catch {
    // Deliberately silent. See the header.
  }
}
