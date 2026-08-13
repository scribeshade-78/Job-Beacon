import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Privileged, server/worker-only Supabase client (service-role key —
 * bypasses RLS). Deliberately kept in its own file, separate from
 * supabaseServer.ts (which only ever holds the publishable key), so the
 * privileged client is never reachable from the JWT-verification path or
 * anywhere a request-scoped client is expected. Never import this from
 * client/src — nothing under server/ is part of the Vite client bundle,
 * and this key must never carry a VITE_ prefix.
 */
export interface SupabaseServiceRoleConfig {
  url: string;
  serviceRoleKey: string;
}

export function readSupabaseServiceRoleConfig(
  env: Record<string, string | undefined> = process.env,
): SupabaseServiceRoleConfig {
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing Supabase service-role configuration: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
    );
  }

  return { url, serviceRoleKey };
}

export function createSupabaseServiceRoleClient(
  config: SupabaseServiceRoleConfig = readSupabaseServiceRoleConfig(),
): SupabaseClient {
  return createClient(config.url, config.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
