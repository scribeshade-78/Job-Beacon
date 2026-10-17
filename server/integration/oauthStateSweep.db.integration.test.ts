import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_OAUTH_STATE_SWEEP_GRACE, runOAuthStateSweep } from "../mailbox/oauthStateSweep.js";
import { createTestDatabaseClient, pickTestCandidateId, removeTestArtifacts } from "./testDatabase.js";

/**
 * THE TTL SWEEP, THROUGH THE REAL POSTGREST STACK.
 *
 * supabase/tests/oauth_state_ttl_sweep.sql already proves the SQL: the function deletes past
 * the grace window and spares everything else. What it cannot prove is that the scheduler can
 * REACH the function at all — and that is not hypothetical. oauth_state shipped without any
 * grant block, so the handshake failed with SQLSTATE 42501 while the mocked unit test stayed
 * green. A maintenance function granted to the wrong role (or to PUBLIC only) fails the same
 * way, and only a call over PostgREST as service_role proves it does not.
 *
 * The wrapper is exercised directly rather than reimplemented here, so this test fails if
 * either the RPC name, the argument name, or the EXECUTE grant drifts.
 *
 *   npm run test:db
 */

describe("purge_expired_oauth_state (DB-backed)", () => {
  let client: SupabaseClient;
  let candidateId: string;
  let nonces: string[];

  beforeEach(async () => {
    client = createTestDatabaseClient();
    candidateId = await pickTestCandidateId(client);
    nonces = [];
  });

  afterEach(async () => {
    await removeTestArtifacts(client, { candidateId, nonces });
  });

  it("sweeps past the grace window while sparing grace-window and live rows", async () => {
    const suffix = randomUUID();
    const expired = `sweep-expired-${suffix}`;
    const withinGrace = `sweep-grace-${suffix}`;
    const live = `sweep-live-${suffix}`;
    nonces = [expired, withinGrace, live];

    const hour = 60 * 60 * 1000;
    const inserted = await client.from("oauth_state").insert([
      { nonce: expired, candidate_id: candidateId, code_verifier: "verifier", expires_at: new Date(Date.now() - 2 * hour).toISOString() },
      { nonce: withinGrace, candidate_id: candidateId, code_verifier: "verifier", expires_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
      { nonce: live, candidate_id: candidateId, code_verifier: "verifier", expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
    ]);
    expect(inserted.error).toBeNull();

    const result = await runOAuthStateSweep(client);

    expect(result.grace).toBe(DEFAULT_OAUTH_STATE_SWEEP_GRACE);
    // Other tests or a previous run may leave expired rows behind; the row-level assertions
    // below are what pin THIS run's behaviour.
    expect(result.purged).toBeGreaterThanOrEqual(1);

    const remaining = await client.from("oauth_state").select("nonce").in("nonce", nonces);
    expect(remaining.error).toBeNull();

    const survivors = (remaining.data ?? []).map((row) => (row as { nonce: string }).nonce).sort();
    expect(survivors).toEqual([live, withinGrace].sort());
  });
});
