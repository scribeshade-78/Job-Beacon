import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { claimMailboxConnectionsForPolling, pollOneMailboxConnection, runMailboxPollingBatch } from "./poll.js";
import type { FetchImpl } from "./oauth.js";
import { encryptMailboxSecret } from "./tokenCrypto.js";

const CONFIG = { clientId: "id", clientSecret: "secret", redirectUri: "https://app.example/callback" };
const KEY = Buffer.alloc(32, 5);

function bundleSecret(expiresAt: number): string {
  return encryptMailboxSecret(KEY, JSON.stringify({ accessToken: "old-at", refreshToken: "rt", expiresAt }));
}

// ---- claimMailboxConnectionsForPolling ----

function makeClaimClient(result: { data: unknown; error: unknown }) {
  const select = vi.fn(async () => result);
  const or = vi.fn(() => ({ select }));
  const eqProvider = vi.fn(() => ({ or }));
  const eqStatus = vi.fn(() => ({ eq: eqProvider }));
  const update = vi.fn((_payload: unknown) => ({ eq: eqStatus }));
  const from = vi.fn(() => ({ update }));
  const client = { from } as unknown as SupabaseClient;
  return { client, from, update, eqStatus, eqProvider };
}

describe("claimMailboxConnectionsForPolling", () => {
  it("filters on status='connected', provider='gmail', and an expired/null lease, returning claimed rows", async () => {
    const rows = [{ id: "conn-1", secret_manager_key: "ct", last_polled_at: null, poll_failure_count: 0 }];
    const { client, from, update, eqStatus, eqProvider } = makeClaimClient({ data: rows, error: null });

    const result = await claimMailboxConnectionsForPolling(client);

    expect(result).toEqual(rows);
    expect(from).toHaveBeenCalledWith("mailbox_connections");
    expect(eqStatus).toHaveBeenCalledWith("status", "connected");
    expect(eqProvider).toHaveBeenCalledWith("provider", "gmail");
    const payload = update.mock.calls[0][0] as unknown as { polling_leased_until: string };
    expect(typeof payload.polling_leased_until).toBe("string");
  });

  it("returns an empty array when nothing is due", async () => {
    const { client } = makeClaimClient({ data: [], error: null });
    expect(await claimMailboxConnectionsForPolling(client)).toEqual([]);
  });

  it("throws on a database error", async () => {
    const { client } = makeClaimClient({ data: null, error: new Error("db down") });
    await expect(claimMailboxConnectionsForPolling(client)).rejects.toThrow("db down");
  });
});

// ---- pollOneMailboxConnection ----

function makePollClient(overrides: { updateResults?: Array<{ error: unknown }>; upsertResults?: Array<{ error: unknown }> } = {}) {
  const updateCalls: unknown[] = [];
  const upsertCalls: Array<{ payload: unknown; options: unknown }> = [];
  let updateIdx = 0;
  let upsertIdx = 0;

  const mailboxUpdate = vi.fn((payload: unknown) => {
    updateCalls.push(payload);
    const result = overrides.updateResults?.[updateIdx] ?? { error: null };
    updateIdx += 1;
    return { eq: vi.fn(async () => result) };
  });

  const messagesUpsert = vi.fn(async (payload: unknown, options: unknown) => {
    upsertCalls.push({ payload, options });
    const result = overrides.upsertResults?.[upsertIdx] ?? { error: null };
    upsertIdx += 1;
    return result;
  });

  const from = vi.fn((table: string) => {
    if (table === "mailbox_connections") {
      return { update: mailboxUpdate };
    }
    if (table === "messages") {
      return { upsert: messagesUpsert };
    }
    throw new Error(`Unexpected table ${table}`);
  });

  const client = { from } as unknown as SupabaseClient;
  return { client, from, mailboxUpdate, messagesUpsert, updateCalls, upsertCalls };
}

function makeGmailFetch(
  options: {
    refreshOk?: boolean;
    refreshErrorCode?: string;
    messageIds?: string[];
    listOk?: boolean;
    listStatus?: number;
  } = {},
): FetchImpl {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = String(url);

    if (urlStr.includes("oauth2.googleapis.com/token")) {
      if (options.refreshOk === false) {
        return { ok: false, status: 400, json: async () => ({ error: options.refreshErrorCode ?? "server_error" }) } as Response;
      }
      return { ok: true, json: async () => ({ access_token: "new-at", expires_in: 3600 }) } as Response;
    }

    if (urlStr.includes("/messages?")) {
      if (options.listOk === false) {
        return { ok: false, status: options.listStatus ?? 500, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({ messages: (options.messageIds ?? []).map((id) => ({ id })) }) } as Response;
    }

    if (urlStr.includes("/messages/")) {
      const id = urlStr.split("/messages/")[1]?.split("?")[0];
      return {
        ok: true,
        json: async () => ({
          id,
          internalDate: "1700000000000",
          payload: { headers: [{ name: "From", value: "recruiter@example.com" }, { name: "Subject", value: "Hi" }] },
        }),
      } as Response;
    }

    throw new Error(`Unexpected fetch to ${urlStr}`);
  });
}

const NOT_EXPIRED_CONNECTION = {
  id: "conn-1",
  secret_manager_key: bundleSecret(Date.now() + 10 * 60 * 1000),
  last_polled_at: null,
  poll_failure_count: 0,
};

const EXPIRED_CONNECTION = {
  id: "conn-1",
  secret_manager_key: bundleSecret(0),
  last_polled_at: null,
  poll_failure_count: 0,
};

describe("pollOneMailboxConnection", () => {
  it("fetches and upserts messages, then records success — without refreshing a still-valid token", async () => {
    const { client, messagesUpsert, mailboxUpdate, updateCalls } = makePollClient();
    const fetchImpl = makeGmailFetch({ messageIds: ["m1", "m2"] });

    const result = await pollOneMailboxConnection(client, NOT_EXPIRED_CONNECTION, CONFIG, KEY, fetchImpl);

    expect(result).toEqual({ connectionId: "conn-1", messagesFetched: 2, outcome: "success" });
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("oauth2.googleapis.com/token"), expect.anything());
    expect(messagesUpsert).toHaveBeenCalledTimes(2);
    expect(messagesUpsert.mock.calls[0][1]).toEqual({ onConflict: "mailbox_connection_id,provider_message_id" });
    expect(messagesUpsert.mock.calls[0][0]).toMatchObject({
      mailbox_connection_id: "conn-1",
      provider_message_id: "m1",
      sender: "recruiter@example.com",
      subject: "Hi",
    });

    expect(mailboxUpdate).toHaveBeenCalledTimes(1); // only the success update — no refresh persist
    expect(updateCalls[0]).toMatchObject({ last_poll_error: null, poll_failure_count: 0 });
  });

  it("refreshes an expired token and persists the new bundle before fetching messages", async () => {
    const { client, mailboxUpdate, updateCalls } = makePollClient();
    const fetchImpl = makeGmailFetch({ messageIds: [] });

    const result = await pollOneMailboxConnection(client, EXPIRED_CONNECTION, CONFIG, KEY, fetchImpl);

    expect(result.outcome).toBe("success");
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("oauth2.googleapis.com/token"), expect.anything());
    // Two updates: persist the refreshed bundle, then the success update.
    expect(mailboxUpdate).toHaveBeenCalledTimes(2);
    expect(typeof (updateCalls[0] as { secret_manager_key: string }).secret_manager_key).toBe("string");
  });

  it("is terminal when secret_manager_key is missing", async () => {
    const { client, mailboxUpdate, updateCalls } = makePollClient();
    const fetchImpl = makeGmailFetch();

    const result = await pollOneMailboxConnection(
      client,
      { ...NOT_EXPIRED_CONNECTION, secret_manager_key: null },
      CONFIG,
      KEY,
      fetchImpl,
    );

    expect(result.outcome).toBe("terminal_error");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(updateCalls[0]).toMatchObject({ status: "error" });
    expect(mailboxUpdate).toHaveBeenCalledTimes(1);
  });

  it("is terminal when the stored secret can't be decrypted", async () => {
    const { client, updateCalls } = makePollClient();
    const fetchImpl = makeGmailFetch();

    const result = await pollOneMailboxConnection(
      client,
      { ...NOT_EXPIRED_CONNECTION, secret_manager_key: "not-valid-ciphertext" },
      CONFIG,
      KEY,
      fetchImpl,
    );

    expect(result.outcome).toBe("terminal_error");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(updateCalls[0]).toMatchObject({ status: "error" });
  });

  it("is terminal on invalid_grant during refresh", async () => {
    const { client, updateCalls } = makePollClient();
    const fetchImpl = makeGmailFetch({ refreshOk: false, refreshErrorCode: "invalid_grant" });

    const result = await pollOneMailboxConnection(client, EXPIRED_CONNECTION, CONFIG, KEY, fetchImpl);

    expect(result.outcome).toBe("terminal_error");
    expect(updateCalls[0]).toMatchObject({ status: "error" });
  });

  it("backs off (not terminal) on a transient Gmail error below the failure cap", async () => {
    const { client, updateCalls } = makePollClient();
    const fetchImpl = makeGmailFetch({ listOk: false, listStatus: 500 });

    const result = await pollOneMailboxConnection(
      client,
      { ...NOT_EXPIRED_CONNECTION, poll_failure_count: 2 },
      CONFIG,
      KEY,
      fetchImpl,
    );

    expect(result.outcome).toBe("transient_error");
    expect(updateCalls[0]).toMatchObject({ poll_failure_count: 3 });
    expect(updateCalls[0]).not.toMatchObject({ status: "error" });
  });

  it("flips to terminal once the 5-strike transient-failure cap is reached", async () => {
    const { client, updateCalls } = makePollClient();
    const fetchImpl = makeGmailFetch({ listOk: false, listStatus: 500 });

    const result = await pollOneMailboxConnection(
      client,
      { ...NOT_EXPIRED_CONNECTION, poll_failure_count: 4 },
      CONFIG,
      KEY,
      fetchImpl,
    );

    expect(result.outcome).toBe("terminal_error");
    expect(updateCalls[0]).toMatchObject({ status: "error" });
  });
});

// ---- runMailboxPollingBatch ----

describe("runMailboxPollingBatch", () => {
  it("claims connections, polls each in isolation, and tallies outcomes", async () => {
    const goodConnection = { id: "conn-good", secret_manager_key: bundleSecret(Date.now() + 10 * 60 * 1000), last_polled_at: null, poll_failure_count: 0 };
    const badConnection = { id: "conn-bad", secret_manager_key: null, last_polled_at: null, poll_failure_count: 0 };

    const select = vi.fn(async () => ({ data: [goodConnection, badConnection], error: null }));
    const claimBuilder = { eq: vi.fn(() => claimBuilder), or: vi.fn(() => claimBuilder), select };
    let updateCallCount = 0;
    const mailboxUpdate = vi.fn(() => {
      updateCallCount += 1;
      // First call is the claim (ends in .select()); subsequent calls are plain per-connection updates.
      if (updateCallCount === 1) {
        return claimBuilder;
      }
      return { eq: vi.fn(async () => ({ error: null })) };
    });
    const messagesUpsert = vi.fn(async () => ({ error: null }));
    const from = vi.fn((table: string) => {
      if (table === "mailbox_connections") {
        return { update: mailboxUpdate };
      }
      if (table === "messages") {
        return { upsert: messagesUpsert };
      }
      throw new Error(`Unexpected table ${table}`);
    });
    const client = { from } as unknown as SupabaseClient;
    const fetchImpl = makeGmailFetch({ messageIds: ["m1"] });

    const result = await runMailboxPollingBatch(client, CONFIG, KEY, fetchImpl);

    expect(result).toEqual({ claimed: 2, succeeded: 1, transientErrors: 0, terminalErrors: 1 });
  });

  it("returns all-zero when nothing is claimed", async () => {
    const select = vi.fn(async () => ({ data: [], error: null }));
    const claimBuilder = { eq: vi.fn(() => claimBuilder), or: vi.fn(() => claimBuilder), select };
    const from = vi.fn(() => ({ update: vi.fn(() => claimBuilder) }));
    const client = { from } as unknown as SupabaseClient;

    const result = await runMailboxPollingBatch(client, CONFIG, KEY, makeGmailFetch());

    expect(result).toEqual({ claimed: 0, succeeded: 0, transientErrors: 0, terminalErrors: 0 });
  });
});
