import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseBrowserConfig {
  url: string;
  publishableKey: string;
}

export function readSupabaseBrowserConfig(
  env: Record<string, string | undefined> = import.meta.env,
): SupabaseBrowserConfig {
  const url = env.VITE_SUPABASE_URL;
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "Missing Supabase browser configuration: VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required.",
    );
  }

  return { url, publishableKey };
}

export function createSupabaseBrowserClient(
  config: SupabaseBrowserConfig = readSupabaseBrowserConfig(),
): SupabaseClient {
  return createClient(config.url, config.publishableKey);
}

let cachedBrowserClient: SupabaseClient | null = null;

/**
 * Lazy singleton — avoids constructing more than one GoTrueClient (and its
 * background auth-state listeners) per page. Fails clearly on first real
 * use if configuration is missing, same as createSupabaseBrowserClient.
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (!cachedBrowserClient) {
    cachedBrowserClient = createSupabaseBrowserClient();
  }

  return cachedBrowserClient;
}
