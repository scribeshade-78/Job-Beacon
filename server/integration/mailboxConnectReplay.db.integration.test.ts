import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeMailboxConnect, InvalidOAuthStateError, startMailboxConnect } from "../mailbox/connect.js";
import type { FetchImpl } from "../mailbox/oauth.js";
import { verifyOAuthState } from "../mailbox/oauthState.js";
import { createTestDatabaseClient, pickTestCandidateId, removeTestArtifacts } from "./testDatabase.js";

/**
 * THE REPLAY PROOF, AGAINST A REAL DATABASE.
 *
 * supabase/tests/oauth_state_replay.sql already proves the SQL: a second
 * `delete ... where nonce = ... returning code_verifier` matches zero rows. What it cannot prove is
 * that completeMailboxConnect — the function that actually runs the callback — consumes the row
 * once, refuses the replay, and is even ALLOWED to touch the table.
 *
 * That last clause is not hypothetical. The oauth_state migration shipped without a grant block, and
 * service_role bypasses RLS but NOT table privileges, so on the real stack every one of these calls
 * failed with `permission denied for table oauth_state` (SQLSTATE 42501) while the mocked unit test
 * in connect.test.ts stayed green. A fake client cannot fail a GRANT it never issues.
 *
 * Google is still mocked (fetchImpl): this suite is about the DATABASE lock, not about the network.
 *
 *   npm run test:db
 */

const CONFIG = {
  clientId: "db-test-client",
  clientSecret: "db-test-secret",
  redirectUri: "https://app.example/callback",
};
const STATE_SECRET = "db-test-state-secret";
const KEY = Buffer.alloc(32, 7);

function makeGoogleFetch(): FetchImpl {
  return (async (url: string | URL | Request) => {
    const urlStr = String(url);

    if (urlStr.includes("oauth2.googleapis.com/token")) {
      return {
        ok: true,
        json: async () => ({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
        }),
      } as Response;
    }

    if (urlStr.includes("openidconnect.googleapis.com/v1/userinfo")) {
      return { ok: true, json: async () => ({ email: "candidate@gmail.com" }) } as Response;
    }

    throw new Error(`Unexpected fetch to ${urlStr}`);
  }) as FetchImpl;
}

describe("completeMailboxConnect nonce consumption (DB-backed)", () => {
  let client: SupabaseClient;
  let candidateId: string;
  let createdNonces: string[];

  beforeEach(async () => {
    client = createTestDatabaseClient();
    candidateId = await pickTestCandidateId(client);
    createdNonces = [];
  });

  afterEach(async () => {
    await removeTestArtifacts(client, { candidateId, nonces: createdNonces });
  });

  it("consumes the nonce once, deletes the row, and structurally rejects a replayed callback", async () => {
    const fetchImpl = makeGoogleFetch();

    // --- The authorize step persists the nonce and its PKCE verifier server-side. ---
    const { authorizeUrl } = await startMailboxConnect(client, candidateId, CONFIG, STATE_SECRET);
    const state = new URL(authorizeUrl).searchParams.get("state");

    if (!state) {
      throw new Error("the authorize URL carried no state parameter");
    }

    const verified = verifyOAuthState(STATE_SECRET, state);
    expect(verified).not.toBeNull();
    const nonce = verified!.nonce;
    createdNonces.push(nonce);

    const stored = await client.from("oauth_state").select("nonce, code_verifier").eq("nonce", nonce);
    expect(stored.error).toBeNull();
    expect(stored.data).toHaveLength(1);

    // --- Callback #1: the DELETE ... RETURNING that matches the row is the one that wins. ---
    const first = await completeMailboxConnect(
      client,
      CONFIG,
      STATE_SECRET,
      KEY,
      { code: "auth-code", state },
      fetchImpl,
    );
    expect(first).toEqual({ candidateId });

    const connections = await client
      .from("mailbox_connections")
      .select("status, candidate_id")
      .eq("candidate_id", candidateId)
      .eq("provider", "gmail");
    expect(connections.error).toBeNull();
    expect(connections.data).toHaveLength(1);
    expect(connections.data?.[0]).toMatchObject({ status: "connected", candidate_id: candidateId });

    // --- Consumption is a DELETE, not a flag: the row is gone. ---
    const remaining = await client.from("oauth_state").select("nonce").eq("nonce", nonce);
    expect(remaining.error).toBeNull();
    expect(remaining.data).toEqual([]);

    // --- Callback #2, the replay: the same consume returns ZERO ROWS. ---
    const replayedConsume = await client
      .from("oauth_state")
      .delete()
      .eq("nonce", nonce)
      .eq("candidate_id", candidateId)
      .select("code_verifier");

    expect(replayedConsume.error).toBeNull();
    expect(replayedConsume.data).toEqual([]);

    // --- And the module turns that zero-row result into a refusal, not a second connection. ---
    await expect(
      completeMailboxConnect(client, CONFIG, STATE_SECRET, KEY, { code: "auth-code", state }, fetchImpl),
    ).rejects.toBeInstanceOf(InvalidOAuthStateError);
  });
});
