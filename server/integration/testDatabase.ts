import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient, readSupabaseServiceRoleConfig } from "../supabaseServiceRole.js";

/**
 * HARNESS FOR DB-BACKED TESTS.
 *
 * WHAT A MOCKED CLIENT CANNOT PROVE. A hand-built fake SupabaseClient proves the SHAPE of the calls
 * a function makes. It cannot prove the database would have accepted them — and privileges,
 * constraints and DELETE ... RETURNING semantics live only in the database. completeMailboxConnect's
 * replay protection is a DELETE ... RETURNING that means nothing unless a real Postgres executes it
 * under the real role. This harness is the smallest thing that closes that gap: a service-role
 * client aimed at the LOCAL Supabase stack, plus the disposable-row bookkeeping around it.
 *
 * LOCAL ONLY, AND IT REFUSES OTHERWISE. These tests delete rows. assertLocalDatabase is the one
 * guard that must never be relaxed: aiming this suite at a hosted project would consume real
 * candidates' OAuth state and mailbox connections. It is checked on every client construction, not
 * once at import time, so a test that builds its own client still passes through it.
 */

// Reads .env when present, so the suite works without exporting by hand — the same convention
// server/integration/adzunaMarkets.integration.test.ts uses. Absent configuration is then reported
// by readSupabaseServiceRoleConfig rather than by a confusing 401 later.
try {
  (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(".env");
} catch {
  // No .env is a normal state; readSupabaseServiceRoleConfig below names what is missing.
}

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function assertLocalDatabase(url: string): void {
  let hostname: string;

  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`SUPABASE_URL is not a parseable URL, so this suite refuses to run: ${url}`);
  }

  if (!LOCAL_HOSTNAMES.has(hostname)) {
    throw new Error(
      `Refusing to run DB-backed tests against a non-local Supabase (${url}). These tests DELETE ` +
        "rows; they may only ever touch the stack started by 'supabase start'.",
    );
  }
}

export function createTestDatabaseClient(): SupabaseClient {
  const config = readSupabaseServiceRoleConfig();
  assertLocalDatabase(config.url);
  return createSupabaseServiceRoleClient(config);
}

/**
 * A candidate_profiles row to hang the test's disposable rows off.
 *
 * Returns an EXISTING row rather than creating one: candidate_profiles.id references auth.users,
 * and service_role is deliberately granted only SELECT on that table. It prefers a candidate with
 * no mailbox connection and REFUSES rather than overwrite a real one.
 */
export async function pickTestCandidateId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.from("candidate_profiles").select("id");

  if (error) {
    throw error;
  }

  const ids = (data ?? []).map((row) => (row as { id: string }).id);

  if (ids.length === 0) {
    throw new Error(
      "No candidate_profiles rows in the local database. Seed it (scripts/reset-fixtures.ts) before running the DB suite.",
    );
  }

  const { data: connections, error: connectionsError } = await client
    .from("mailbox_connections")
    .select("candidate_id")
    .in("candidate_id", ids);

  if (connectionsError) {
    throw connectionsError;
  }

  const taken = new Set((connections ?? []).map((row) => (row as { candidate_id: string }).candidate_id));
  const free = ids.find((id) => !taken.has(id));

  if (!free) {
    throw new Error(
      "Every candidate_profiles row already has a mailbox connection, and this suite will not " +
        "overwrite one. Add a disposable candidate profile to the local database.",
    );
  }

  return free;
}

/** Removes the rows one test run wrote, so the local stack is left exactly as it was found. */
export async function removeTestArtifacts(
  client: SupabaseClient,
  options: { candidateId: string; nonces: string[] },
): Promise<void> {
  if (options.nonces.length > 0) {
    await client.from("oauth_state").delete().in("nonce", options.nonces);
  }

  await client
    .from("mailbox_connections")
    .delete()
    .eq("candidate_id", options.candidateId)
    .eq("provider", "gmail");
}
