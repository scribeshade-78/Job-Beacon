import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  completeMailboxConnect,
  disconnectMailboxConnection,
  InvalidOAuthStateError,
  MailboxConnectionNotFoundError,
  startMailboxConnect,
} from "./connect.js";
import { createOAuthState } from "./oauthState.js";
import { encryptMailboxSecret } from "./tokenCrypto.js";
import type { FetchImpl } from "./oauth.js";

const CONFIG = { clientId: "id", clientSecret: "secret", redirectUri: "https://app.example/callback" };
const STATE_SECRET = "state-secret";
const KEY = Buffer.alloc(32, 3);

function makeGoogleFetch(): FetchImpl {
  return vi.fn(async (url: string | URL | Request) => {
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

    if (urlStr.includes("oauth2.googleapis.com/revoke")) {
      return { ok: true, json: async () => ({}) } as Response;
    }

    throw new Error(`Unexpected fetch to ${urlStr}`);
  });
}

function makeClient(overrides: {
  selectResult?: { data: unknown; error: unknown };
  updateResult?: { error: unknown };
  upsertResult?: { error: unknown };
} = {}) {
  const upsert = vi.fn(async (_payload: unknown, _options: unknown) => overrides.upsertResult ?? { error: null });
  const updateEq = vi.fn(async () => overrides.updateResult ?? { error: null });
  const update = vi.fn(() => ({ eq: updateEq }));
  const maybeSingle = vi.fn(async () => overrides.selectResult ?? { data: null, error: null });
  const selectEq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq: selectEq }));
  const from = vi.fn(() => ({ upsert, update, select }));
  const client = { from } as unknown as SupabaseClient;

  return { client, from, upsert, update, updateEq, select, selectEq, maybeSingle };
}

describe("startMailboxConnect", () => {
  it("returns an authorize URL carrying a state that verifies back to the candidate", () => {
    const { authorizeUrl } = startMailboxConnect("candidate-1", CONFIG, STATE_SECRET);
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get("state")).toBeTruthy();
  });
});

describe("completeMailboxConnect", () => {
  it("throws InvalidOAuthStateError for a bad state, without calling Google", async () => {
    const { client } = makeClient();
    const fetchImpl = makeGoogleFetch();

    await expect(
      completeMailboxConnect(client, CONFIG, STATE_SECRET, KEY, { code: "code", state: "garbage" }, fetchImpl),
    ).rejects.toBeInstanceOf(InvalidOAuthStateError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("upserts a connected row keyed on (candidate_id, provider) with an encrypted secret", async () => {
    const { client, from, upsert } = makeClient({ upsertResult: { error: null } });
    const fetchImpl = makeGoogleFetch();
    const state = createOAuthState(STATE_SECRET, "candidate-1");

    const result = await completeMailboxConnect(client, CONFIG, STATE_SECRET, KEY, { code: "auth-code", state }, fetchImpl);

    expect(result).toEqual({ candidateId: "candidate-1" });
    expect(from).toHaveBeenCalledWith("mailbox_connections");

    const call = upsert.mock.calls[0] as [Record<string, unknown>, unknown];
    const [payload, options] = call;
    expect(options).toEqual({ onConflict: "candidate_id,provider" });
    expect(payload).toMatchObject({
      candidate_id: "candidate-1",
      provider: "gmail",
      status: "connected",
      email_address: "candidate@gmail.com",
      granted_scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
      revoked_at: null,
    });
    expect(typeof payload.secret_manager_key).toBe("string");
    expect(payload.secret_manager_key).not.toContain("refresh-token");
  });

  it("rethrows a database error from the upsert", async () => {
    const { client } = makeClient({ upsertResult: { error: new Error("db down") } });
    const fetchImpl = makeGoogleFetch();
    const state = createOAuthState(STATE_SECRET, "candidate-1");

    await expect(
      completeMailboxConnect(client, CONFIG, STATE_SECRET, KEY, { code: "auth-code", state }, fetchImpl),
    ).rejects.toThrow("db down");
  });
});

describe("disconnectMailboxConnection", () => {
  it("throws MailboxConnectionNotFoundError when the row doesn't exist", async () => {
    const { client } = makeClient({ selectResult: { data: null, error: null } });

    await expect(
      disconnectMailboxConnection(client, { connectionId: "conn-1", candidateId: "candidate-1" }, KEY),
    ).rejects.toBeInstanceOf(MailboxConnectionNotFoundError);
  });

  it("throws MailboxConnectionNotFoundError when the row belongs to a different candidate", async () => {
    const { client } = makeClient({
      selectResult: { data: { id: "conn-1", candidate_id: "someone-else", secret_manager_key: null, status: "connected" }, error: null },
    });

    await expect(
      disconnectMailboxConnection(client, { connectionId: "conn-1", candidateId: "candidate-1" }, KEY),
    ).rejects.toBeInstanceOf(MailboxConnectionNotFoundError);
  });

  it("is a no-op that skips revocation when already revoked", async () => {
    const { client, update } = makeClient({
      selectResult: { data: { id: "conn-1", candidate_id: "candidate-1", secret_manager_key: null, status: "revoked" }, error: null },
    });
    const fetchImpl = makeGoogleFetch();

    const result = await disconnectMailboxConnection(client, { connectionId: "conn-1", candidateId: "candidate-1" }, KEY, fetchImpl);

    expect(result).toEqual({ id: "conn-1" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("revokes at Google, then marks the row revoked and clears the secret", async () => {
    const secretManagerKey = encryptMailboxSecret(KEY, JSON.stringify({ accessToken: "at", refreshToken: "rt", expiresAt: 0 }));
    const { client, update, updateEq } = makeClient({
      selectResult: { data: { id: "conn-1", candidate_id: "candidate-1", secret_manager_key: secretManagerKey, status: "connected" }, error: null },
    });
    const fetchImpl = makeGoogleFetch();

    const result = await disconnectMailboxConnection(client, { connectionId: "conn-1", candidateId: "candidate-1" }, KEY, fetchImpl);

    expect(result).toEqual({ id: "conn-1" });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("oauth2.googleapis.com/revoke"), expect.anything());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "revoked", secret_manager_key: null }));
    expect(updateEq).toHaveBeenCalledWith("id", "conn-1");
  });

  it("still revokes locally even if the stored secret is corrupted", async () => {
    const { client, update } = makeClient({
      selectResult: { data: { id: "conn-1", candidate_id: "candidate-1", secret_manager_key: "not-valid-ciphertext", status: "connected" }, error: null },
    });
    const fetchImpl = makeGoogleFetch();

    const result = await disconnectMailboxConnection(client, { connectionId: "conn-1", candidateId: "candidate-1" }, KEY, fetchImpl);

    expect(result).toEqual({ id: "conn-1" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "revoked" }));
  });
});
