import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleAuthCode,
  fetchGoogleEmailAddress,
  GOOGLE_MAILBOX_SCOPES,
  revokeGoogleToken,
  type FetchImpl,
  type GoogleOAuthConfig,
  type StoredMailboxTokenBundle,
} from "./oauth.js";
import { createOAuthState, verifyOAuthState } from "./oauthState.js";
import { decryptMailboxSecret, encryptMailboxSecret } from "./tokenCrypto.js";

const PROVIDER = "gmail";

/**
 * NOW ASYNC AND NOW TAKES A CLIENT, because the handshake needs durable state.
 *
 * A SIGNED STATE ALONE IS A BEARER TOKEN. Anyone who captures the value — browser history, a
 * Referer leak, a shared URL — could replay it for its whole TTL. Persisting the nonce is what
 * makes the callback able to CONSUME it, and the verifier rides along because it must survive the
 * same round trip.
 */
export async function startMailboxConnect(
  client: SupabaseClient,
  candidateId: string,
  config: GoogleOAuthConfig,
  stateSecret: string,
): Promise<{ authorizeUrl: string }> {
  const created = createOAuthState(stateSecret, candidateId);

  const { error } = await client.from("oauth_state").insert({
    nonce: created.nonce,
    candidate_id: candidateId,
    code_verifier: created.codeVerifier,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  if (error) {
    throw error;
  }

  return { authorizeUrl: buildGoogleAuthorizeUrl(config, created.state, created.codeChallenge) };
}

export class InvalidOAuthStateError extends Error {}

/**
 * candidate_id comes only from the verified `state` param (never from
 * client-supplied input) — the same identity-trust boundary every other
 * candidate-facing write in this project holds to (see reports.ts,
 * moderation/decisions.ts). Upserts on (candidate_id, provider) — the
 * unique constraint 20260825060000 added — so reconnecting updates the
 * one existing row instead of leaving a stale duplicate.
 */
export async function completeMailboxConnect(
  client: SupabaseClient,
  config: GoogleOAuthConfig,
  stateSecret: string,
  encryptionKey: Buffer,
  input: { code: string; state: string },
  fetchImpl: FetchImpl = fetch,
): Promise<{ candidateId: string }> {
  const verified = verifyOAuthState(stateSecret, input.state);

  if (!verified) {
    throw new InvalidOAuthStateError("Invalid or expired OAuth state.");
  }

  // ATOMIC CONSUMPTION. DELETE ... RETURNING keyed on the nonce: the callback that matches the row
  // is the one that proceeds, and a REPLAYED nonce deletes nothing. Checking "have I seen this
  // nonce" and then marking it used would leave a window between the two, which is exactly the
  // race the row-level delete removes.
  const { data: consumed, error: consumeError } = await client
    .from("oauth_state")
    .delete()
    .eq("nonce", verified.nonce)
    .eq("candidate_id", verified.candidateId)
    .select("code_verifier")
    .maybeSingle();

  if (consumeError) {
    throw consumeError;
  }

  if (!consumed) {
    throw new InvalidOAuthStateError("This authorization link has already been used.");
  }

  const consumedRow = consumed as { code_verifier: string };
  const tokens = await exchangeGoogleAuthCode(config, input.code, fetchImpl, consumedRow.code_verifier);
  const emailAddress = await fetchGoogleEmailAddress(tokens.accessToken, fetchImpl);

  const bundle: StoredMailboxTokenBundle = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  };
  const secretManagerKey = encryptMailboxSecret(encryptionKey, JSON.stringify(bundle));

  const { error } = await client.from("mailbox_connections").upsert(
    {
      candidate_id: verified.candidateId,
      provider: PROVIDER,
      status: "connected",
      email_address: emailAddress,
      granted_scopes: tokens.scope ? tokens.scope.split(" ") : [...GOOGLE_MAILBOX_SCOPES],
      secret_manager_key: secretManagerKey,
      connected_at: new Date().toISOString(),
      revoked_at: null,
    },
    { onConflict: "candidate_id,provider" },
  );

  if (error) {
    throw error;
  }

  return { candidateId: verified.candidateId };
}

export class MailboxConnectionNotFoundError extends Error {}

interface MailboxConnectionRow {
  id: string;
  candidate_id: string;
  secret_manager_key: string | null;
  status: string;
}

/**
 * This route uses the service-role client (no request-scoped RLS client
 * exists for server routes in this project — see moderation/decisions.ts),
 * so ownership (candidate_id === the verified session's user id) must be
 * checked in application code, not left to RLS.
 */
export async function disconnectMailboxConnection(
  client: SupabaseClient,
  input: { connectionId: string; candidateId: string },
  encryptionKey: Buffer,
  fetchImpl: FetchImpl = fetch,
): Promise<{ id: string }> {
  const { data, error } = await client
    .from("mailbox_connections")
    .select("id, candidate_id, secret_manager_key, status")
    .eq("id", input.connectionId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const row = data as MailboxConnectionRow | null;

  if (!row || row.candidate_id !== input.candidateId) {
    throw new MailboxConnectionNotFoundError("Mailbox connection not found.");
  }

  if (row.status === "revoked") {
    return { id: row.id };
  }

  if (row.secret_manager_key) {
    try {
      const bundle = JSON.parse(decryptMailboxSecret(encryptionKey, row.secret_manager_key)) as StoredMailboxTokenBundle;
      await revokeGoogleToken(bundle.accessToken, fetchImpl);
    } catch {
      // Best-effort — see revokeGoogleToken's own comment; the local revoke below proceeds regardless.
    }
  }

  const { error: updateError } = await client
    .from("mailbox_connections")
    .update({ status: "revoked", revoked_at: new Date().toISOString(), secret_manager_key: null })
    .eq("id", row.id);

  if (updateError) {
    throw updateError;
  }

  return { id: row.id };
}
