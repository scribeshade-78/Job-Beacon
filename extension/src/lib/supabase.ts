import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase, backed by chrome.storage rather than localStorage.
 *
 * WHY NOT THE DEFAULT STORAGE. supabase-js defaults to window.localStorage, which does
 * not exist in a Manifest V3 service worker at all - and even in the popup it would be
 * per-window storage that disappears when the popup closes. The session has to survive
 * both, so it lives in chrome.storage.local and every context reads the same copy.
 *
 * ONLY THE PUBLISHABLE KEY IS HERE, AND THAT IS BY DESIGN. The anon key is a public
 * identifier that ships in the web app's bundle too; it grants nothing on its own,
 * because every table is behind RLS keyed to the signed-in user. The service-role key
 * must never appear in this extension.
 *
 * detectSessionInUrl IS OFF because a service worker has no URL to parse, and a popup
 * that tried to read one would find the extension's own chrome-extension:// address.
 */
const storageAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    const result = await chrome.storage.local.get(key);
    const value = result[key];
    return typeof value === "string" ? value : null;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    await chrome.storage.local.set({ [key]: value });
  },
  removeItem: async (key: string): Promise<void> => {
    await chrome.storage.local.remove(key);
  },
};

let cached: SupabaseClient | null = null;

/**
 * One client per worker lifetime.
 *
 * CACHED ON PURPOSE: each client owns its own refresh timer and lock. Building a second
 * one per message would have them racing to refresh the same refresh token, and Supabase
 * rotates refresh tokens on use - so the loser of that race holds a token that is
 * already dead and signs the candidate out for no reason.
 */
export function supabase(): SupabaseClient {
  if (cached) {
    return cached;
  }

  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    // A build-time failure, not a runtime one: if this is ever reachable the build was
    // made without the VITE_ vars and the extension cannot work at all.
    throw new Error("This build is missing its Supabase configuration. Rebuild with VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY set.");
  }

  cached = createClient(url, publishableKey, {
    auth: {
      storage: storageAdapter,
      storageKey: "jobbeacon-extension-auth",
      persistSession: true,
      autoRefreshToken: true,
      // No URL to inspect in a service worker, and the popup's URL is an extension one.
      detectSessionInUrl: false,
    },
  });

  return cached;
}

/**
 * A guaranteed-fresh access token, or null when there is no session.
 *
 * REFRESHED EXPLICITLY AND EARLY, rather than trusting autoRefreshToken. A Manifest V3
 * service worker is killed when idle, so its refresh timer is not a reliable scheduler -
 * a token can be minutes from expiry when the worker wakes up. Refreshing inside a
 * 60-second window makes the answer independent of whether the timer survived.
 */
export async function freshAccessToken(): Promise<string | null> {
  const client = supabase();
  const { data } = await client.auth.getSession();
  const session = data.session;

  if (!session) {
    return null;
  }

  const expiresAtSeconds = session.expires_at ?? 0;
  const secondsRemaining = expiresAtSeconds - Math.floor(Date.now() / 1000);

  if (secondsRemaining > 60) {
    return session.access_token;
  }

  const { data: refreshed, error } = await client.auth.refreshSession();
  if (error || !refreshed.session) {
    // An expired refresh token is a signed-out user, not a crash.
    return null;
  }

  return refreshed.session.access_token;
}
