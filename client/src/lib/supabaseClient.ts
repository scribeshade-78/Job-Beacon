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
