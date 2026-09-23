import { useSyncExternalStore } from "react";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "./supabaseClient";

export type AuthStatus = "loading" | "signedOut" | "confirmationPending" | "signedIn" | "error";

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  session: Session | null;
  error: string | null;
}

type Listener = () => void;

export interface AuthStore {
  getState(): AuthState;
  subscribe(listener: Listener): () => void;
  signUp(email: string, password: string): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signInWithGoogle(): Promise<void>;
  signOut(): Promise<void>;
  dispose(): void;
}

function toAuthUser(user: User | null | undefined): AuthUser | null {
  if (!user) {
    return null;
  }

  return { id: user.id, email: user.email ?? null };
}

const initialState: AuthState = { status: "loading", user: null, session: null, error: null };

/**
 * Framework-independent auth state store. Creates exactly one
 * `onAuthStateChange` subscription for its lifetime; call `dispose()` to
 * tear it down. The callback only performs synchronous state updates —
 * no awaited Supabase calls happen inside it (current supabase-js guidance:
 * the async onAuthStateChange overload is deprecated specifically because
 * calling `refreshSession` from inside a TOKEN_REFRESHED handler can
 * deadlock; kept as a blanket rule here so no future addition reintroduces
 * that hazard). Protected API fetching is a separate function
 * (`fetchVerifiedIdentity`) called from outside this callback.
 */
export function createAuthStore(
  client: SupabaseClient,
  options: { emailRedirectTo?: string } = {},
): AuthStore {
  const emailRedirectTo = options.emailRedirectTo ?? window.location.origin;

  let state: AuthState = initialState;
  const listeners = new Set<Listener>();

  function setState(next: AuthState) {
    state = next;
    listeners.forEach((listener) => listener());
  }

  const {
    data: { subscription },
  } = client.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      setState({ status: "signedOut", user: null, session: null, error: null });
      return;
    }

    if (session) {
      setState({ status: "signedIn", user: toAuthUser(session.user), session, error: null });
      return;
    }

    // INITIAL_SESSION with no persisted session, or any other event with no session.
    setState({ status: "signedOut", user: null, session: null, error: null });
  });

  async function signUp(email: string, password: string): Promise<void> {
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo },
    });

    if (error) {
      setState({ status: "error", user: null, session: null, error: error.message });
      return;
    }

    if (!data.session) {
      setState({ status: "confirmationPending", user: null, session: null, error: null });
      return;
    }

    setState({
      status: "signedIn",
      user: toAuthUser(data.user),
      session: data.session,
      error: null,
    });
  }

  async function signIn(email: string, password: string): Promise<void> {
    const { data, error } = await client.auth.signInWithPassword({ email, password });

    if (error) {
      setState({ status: "error", user: null, session: null, error: error.message });
      return;
    }

    setState({
      status: "signedIn",
      user: toAuthUser(data.user),
      session: data.session,
      error: null,
    });
  }

  /**
   * Google OAuth. Deliberately does NOT set a signed-in state on success,
   * unlike signUp/signIn: a successful call navigates the browser away to
   * Google, so this page unloads before any state update here could matter.
   * The session comes back on the return leg through onAuthStateChange, which
   * is already handled above. Only a failure — provider not enabled on the
   * Supabase project, popup blocked, network — has anything to report.
   *
   * Does not distinguish sign-up from log-in because Supabase does not either:
   * one call creates the account or signs into it, whichever applies.
   */
  async function signInWithGoogle(): Promise<void> {
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: emailRedirectTo },
    });

    if (error) {
      setState({ status: "error", user: null, session: null, error: error.message });
    }
  }

  async function signOut(): Promise<void> {
    await client.auth.signOut();
    // onAuthStateChange's SIGNED_OUT event updates state.
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signUp,
    signIn,
    signInWithGoogle,
    signOut,
    dispose: () => {
      subscription.unsubscribe();
      listeners.clear();
    },
  };
}

let singletonStore: AuthStore | null = null;

function getAuthStore(): AuthStore {
  if (!singletonStore) {
    singletonStore = createAuthStore(getSupabaseBrowserClient());
  }

  return singletonStore;
}

export function useAuth() {
  const store = getAuthStore();
  const state = useSyncExternalStore(store.subscribe, store.getState);

  return {
    ...state,
    signUp: store.signUp,
    signIn: store.signIn,
    signInWithGoogle: store.signInWithGoogle,
    signOut: store.signOut,
  };
}

/**
 * R3.1: /api/me's response, not toAuthUser's — the raw Supabase session
 * (toAuthUser's input) carries no app-specific role data, so isModerator
 * can only ever come from the server. Kept as its own type rather than
 * added to AuthUser itself, which toAuthUser still constructs without it.
 */
export interface VerifiedIdentity extends AuthUser {
  isModerator: boolean;
  /** R5.4a: any *verified* employer_claims row — a UX signal only, same caveat isModerator carries (the real per-company boundary is server-side requireEmployerOf). */
  isEmployer: boolean;
  /** R8.1: an 'admin' user_roles row — a UX signal only (gates the /admin nav + route render); the real boundary is server-side requireAdmin. */
  isAdmin: boolean;
}

export type MeResult =
  | { kind: "success"; user: VerifiedIdentity }
  | { kind: "unauthenticated" }
  | { kind: "retryableError"; message: string };

/**
 * Calls the protected /api/me endpoint. On a 401, attempts at most one
 * Supabase session refresh and one retry — never loops. Network failures
 * and 5xx responses are treated as retryable server errors that keep the
 * session; only a 401 that survives a refresh+retry is "unauthenticated".
 */
export async function fetchVerifiedIdentity(
  client: Pick<SupabaseClient, "auth">,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MeResult> {
  async function attempt(token: string): Promise<Response | null> {
    try {
      return await fetchImpl("/api/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      return null;
    }
  }

  let response = await attempt(accessToken);

  if (response === null) {
    return { kind: "retryableError", message: "Network error contacting the server." };
  }

  if (response.status === 401) {
    const { data, error } = await client.auth.refreshSession();

    if (error || !data.session) {
      return { kind: "unauthenticated" };
    }

    response = await attempt(data.session.access_token);

    if (response === null) {
      return { kind: "retryableError", message: "Network error contacting the server." };
    }

    if (response.status === 401) {
      return { kind: "unauthenticated" };
    }
  }

  if (response.status >= 500) {
    return { kind: "retryableError", message: "Server error. Please try again." };
  }

  if (!response.ok) {
    return { kind: "retryableError", message: "Unexpected error. Please try again." };
  }

  const body = (await response.json()) as VerifiedIdentity;
  return { kind: "success", user: body };
}
