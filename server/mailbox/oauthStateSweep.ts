import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * TTL sweep for oauth_state.
 *
 * The delete itself lives in the database (public.purge_expired_oauth_state, 20261019140000)
 * for one reason worth restating: the invariant must be testable without a timer. This module
 * is only the driver - it names the grace window, calls the function, and turns the row count
 * into something the scheduler log can report.
 *
 * WHY THE GRACE WINDOW EXISTS. expires_at is written from the application clock; the sweep
 * compares against the database clock. A bare "expires_at < now()" sweep would delete a row
 * the app still considers live if the two clocks disagree, turning a slow-but-legitimate
 * callback into "This authorization link has already been used." The row is inert either way,
 * so an hour of slack is free insurance rather than a correctness risk.
 */

/**
 * Mirrors the SQL function's own default and is passed explicitly so the scheduler log states
 * the window actually applied rather than leaving an operator to read the migration.
 */
export const DEFAULT_OAUTH_STATE_SWEEP_GRACE = "1 hour";

export interface OAuthStateSweepResult {
  /** Rows removed by this call. The SQL function caps one call at a single batch. */
  purged: number;
  /** The grace window applied, echoed into the completion log. */
  grace: string;
}

export async function runOAuthStateSweep(
  client: SupabaseClient,
  options: { grace?: string } = {},
): Promise<OAuthStateSweepResult> {
  const grace = options.grace ?? DEFAULT_OAUTH_STATE_SWEEP_GRACE;

  const { data, error } = await client.rpc("purge_expired_oauth_state", {
    grace_interval: grace,
  });

  if (error) {
    throw error;
  }

  // PostgREST returns a scalar function's value directly. Anything that is not a whole
  // number means the contract moved, and reporting it as "0 purged" would be a silent
  // success claim on a sweep that did nothing.
  const raw: unknown = data;
  const purged =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;

  if (!Number.isInteger(purged)) {
    throw new Error(
      `purge_expired_oauth_state returned a non-integer row count: ${JSON.stringify(raw)}`,
    );
  }

  return { purged, grace };
}
