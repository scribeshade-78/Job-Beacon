import type { AuthChangeEvent, Session, SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { createAuthStore, fetchVerifiedIdentity } from "./auth";

type StateChangeCallback = (event: AuthChangeEvent, session: Session | null) => void;

function createMockClient(
  overrides: Partial<{
    signUp: ReturnType<typeof vi.fn>;
    signInWithPassword: ReturnType<typeof vi.fn>;
    signInWithOAuth: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
  }> = {},
) {
  let stateChangeCallback: StateChangeCallback | null = null;
  const unsubscribe = vi.fn();

  const client = {
    auth: {
      onAuthStateChange: vi.fn((callback: StateChangeCallback) => {
        stateChangeCallback = callback;
        return { data: { subscription: { unsubscribe } } };
      }),
      signUp: overrides.signUp ?? vi.fn(),
      signInWithPassword: overrides.signInWithPassword ?? vi.fn(),
      signInWithOAuth: overrides.signInWithOAuth ?? vi.fn().mockResolvedValue({ error: null }),
      signOut: overrides.signOut ?? vi.fn().mockResolvedValue({ error: null }),
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    unsubscribe,
    emit: (event: AuthChangeEvent, session: Session | null) => stateChangeCallback?.(event, session),
  };
}

const testRedirect = { emailRedirectTo: "http://127.0.0.1:5173" };

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    access_token: "tok",
    refresh_token: "refresh",
    expires_in: 3600,
    token_type: "bearer",
    user: { id: "u1", email: "a@example.com" },
    ...overrides,
  } as Session;
}

describe("createAuthStore", () => {
  it("starts in loading status", () => {
    const { client } = createMockClient();
    const store = createAuthStore(client, testRedirect);

    expect(store.getState().status).toBe("loading");
  });

  it("creates exactly one Supabase auth subscription", () => {
    const { client } = createMockClient();
    createAuthStore(client, testRedirect);

    expect(client.auth.onAuthStateChange).toHaveBeenCalledOnce();
  });

  it("transitions to signedOut on INITIAL_SESSION with no session", () => {
    const { client, emit } = createMockClient();
    const store = createAuthStore(client, testRedirect);

    emit("INITIAL_SESSION", null);

    expect(store.getState().status).toBe("signedOut");
  });

  it("transitions to signedIn on INITIAL_SESSION with a restored session", () => {
    const { client, emit } = createMockClient();
    const store = createAuthStore(client, testRedirect);
    const session = fakeSession();

    emit("INITIAL_SESSION", session);

    const state = store.getState();
    expect(state.status).toBe("signedIn");
    expect(state.user).toEqual({ id: "u1", email: "a@example.com" });
    expect(state.session).toBe(session);
  });

  it("transitions to signedIn and updates the session on TOKEN_REFRESHED", () => {
    const { client, emit } = createMockClient();
    const store = createAuthStore(client, testRedirect);
    const refreshedSession = fakeSession({ access_token: "new-tok" });

    emit("TOKEN_REFRESHED", refreshedSession);

    const state = store.getState();
    expect(state.status).toBe("signedIn");
    expect(state.session?.access_token).toBe("new-tok");
  });

  it("transitions to signedOut on SIGNED_OUT", () => {
    const { client, emit } = createMockClient();
    const store = createAuthStore(client, testRedirect);

    emit("SIGNED_IN", fakeSession());
    emit("SIGNED_OUT", null);

    const state = store.getState();
    expect(state.status).toBe("signedOut");
    expect(state.user).toBeNull();
    expect(state.session).toBeNull();
  });

  it("goes to confirmationPending when signUp succeeds with no session", async () => {
    const signUp = vi.fn().mockResolvedValue({
      data: { user: { id: "u1" }, session: null },
      error: null,
    });
    const { client } = createMockClient({ signUp });
    const store = createAuthStore(client, testRedirect);

    await store.signUp("a@example.com", "password123");

    expect(store.getState().status).toBe("confirmationPending");
    expect(signUp).toHaveBeenCalledWith({
      email: "a@example.com",
      password: "password123",
      options: { emailRedirectTo: "http://127.0.0.1:5173" },
    });
  });

  it("goes to signedIn when signUp succeeds with an immediate session", async () => {
    const session = fakeSession();
    const signUp = vi.fn().mockResolvedValue({
      data: { user: session.user, session },
      error: null,
    });
    const { client } = createMockClient({ signUp });
    const store = createAuthStore(client, testRedirect);

    await store.signUp("a@example.com", "password123");

    expect(store.getState().status).toBe("signedIn");
  });

  it("goes to error when signUp fails", async () => {
    const signUp = vi.fn().mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Email already registered" },
    });
    const { client } = createMockClient({ signUp });
    const store = createAuthStore(client, testRedirect);

    await store.signUp("a@example.com", "password123");

    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBe("Email already registered");
  });

  it("goes to signedIn when signIn succeeds", async () => {
    const session = fakeSession();
    const signInWithPassword = vi.fn().mockResolvedValue({
      data: { user: session.user, session },
      error: null,
    });
    const { client } = createMockClient({ signInWithPassword });
    const store = createAuthStore(client, testRedirect);

    await store.signIn("a@example.com", "password123");

    expect(store.getState().status).toBe("signedIn");
  });

  it("goes to error when signIn fails with wrong credentials", async () => {
    const signInWithPassword = vi.fn().mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Invalid login credentials" },
    });
    const { client } = createMockClient({ signInWithPassword });
    const store = createAuthStore(client, testRedirect);

    await store.signIn("a@example.com", "wrong-password");

    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBe("Invalid login credentials");
  });

  it("calls signInWithOAuth for google with the configured redirect", async () => {
    const signInWithOAuth = vi
      .fn()
      .mockResolvedValue({ data: { provider: "google", url: "https://accounts.google.com/o/oauth2" }, error: null });
    const { client } = createMockClient({ signInWithOAuth });
    const store = createAuthStore(client, testRedirect);

    await store.signInWithGoogle();

    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: testRedirect.emailRedirectTo },
    });
  });

  it("leaves state untouched after a successful signInWithGoogle", async () => {
    const signInWithOAuth = vi
      .fn()
      .mockResolvedValue({ data: { provider: "google", url: "https://accounts.google.com/o/oauth2" }, error: null });
    const { client } = createMockClient({ signInWithOAuth });
    const store = createAuthStore(client, testRedirect);

    await store.signInWithGoogle();

    // Success means the browser is leaving for Google, so there is no signed-in
    // state to set. The session arrives via onAuthStateChange on the way back.
    expect(store.getState().status).toBe("loading");
  });

  it("goes to error when the google provider is not enabled on the project", async () => {
    const signInWithOAuth = vi.fn().mockResolvedValue({
      data: { provider: "google", url: null },
      error: { message: "Unsupported provider: provider is not enabled" },
    });
    const { client } = createMockClient({ signInWithOAuth });
    const store = createAuthStore(client, testRedirect);

    await store.signInWithGoogle();

    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBe("Unsupported provider: provider is not enabled");
  });

  it("calls client.auth.signOut() on signOut", async () => {
    const signOut = vi.fn().mockResolvedValue({ error: null });
    const { client } = createMockClient({ signOut });
    const store = createAuthStore(client, testRedirect);

    await store.signOut();

    expect(signOut).toHaveBeenCalledOnce();
  });

  it("unsubscribes from the underlying Supabase subscription on dispose", () => {
    const { client, unsubscribe } = createMockClient();
    const store = createAuthStore(client, testRedirect);

    store.dispose();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("notifies subscribers on state changes and stops after unsubscribing", () => {
    const { client, emit } = createMockClient();
    const store = createAuthStore(client, testRedirect);
    const listener = vi.fn();
    const unsubscribeListener = store.subscribe(listener);

    emit("INITIAL_SESSION", null);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribeListener();
    emit("SIGNED_OUT", null);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("fetchVerifiedIdentity", () => {
  it("returns success on a 200 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ id: "u1", email: "a@example.com" }),
    });
    const client = { auth: { refreshSession: vi.fn() } } as unknown as Pick<SupabaseClient, "auth">;

    const result = await fetchVerifiedIdentity(client, "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "success", user: { id: "u1", email: "a@example.com" } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refreshes once and retries once on a 401, succeeding on retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, ok: false })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ id: "u1", email: "a@example.com" }),
      });
    const refreshSession = vi.fn().mockResolvedValue({
      data: { session: { access_token: "new-tok" } },
      error: null,
    });
    const client = { auth: { refreshSession } } as unknown as Pick<SupabaseClient, "auth">;

    const result = await fetchVerifiedIdentity(client, "old-tok", fetchImpl as unknown as typeof fetch);

    expect(refreshSession).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/me", {
      headers: { Authorization: "Bearer new-tok" },
    });
    expect(result).toEqual({ kind: "success", user: { id: "u1", email: "a@example.com" } });
  });

  it("returns unauthenticated when refresh fails after a 401, without retrying in a loop", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ status: 401, ok: false });
    const refreshSession = vi.fn().mockResolvedValue({
      data: { session: null },
      error: { message: "invalid refresh token" },
    });
    const client = { auth: { refreshSession } } as unknown as Pick<SupabaseClient, "auth">;

    const result = await fetchVerifiedIdentity(client, "old-tok", fetchImpl as unknown as typeof fetch);

    expect(refreshSession).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: "unauthenticated" });
  });

  it("returns unauthenticated when the retry after refresh also gets a 401 (no further loop)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, ok: false })
      .mockResolvedValueOnce({ status: 401, ok: false });
    const refreshSession = vi.fn().mockResolvedValue({
      data: { session: { access_token: "new-tok" } },
      error: null,
    });
    const client = { auth: { refreshSession } } as unknown as Pick<SupabaseClient, "auth">;

    const result = await fetchVerifiedIdentity(client, "old-tok", fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: "unauthenticated" });
  });

  it("returns a retryable error and keeps the session on a network failure, without refreshing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const refreshSession = vi.fn();
    const client = { auth: { refreshSession } } as unknown as Pick<SupabaseClient, "auth">;

    const result = await fetchVerifiedIdentity(client, "tok", fetchImpl as unknown as typeof fetch);

    expect(result.kind).toBe("retryableError");
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("returns a retryable error and keeps the session on a 5xx response, without refreshing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 503, ok: false });
    const refreshSession = vi.fn();
    const client = { auth: { refreshSession } } as unknown as Pick<SupabaseClient, "auth">;

    const result = await fetchVerifiedIdentity(client, "tok", fetchImpl as unknown as typeof fetch);

    expect(result.kind).toBe("retryableError");
    expect(refreshSession).not.toHaveBeenCalled();
  });
});
