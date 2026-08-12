import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseServerConfig {
  url: string;
  publishableKey: string;
}

export function readSupabaseServerConfig(
  env: Record<string, string | undefined> = process.env,
): SupabaseServerConfig {
  const url = env.SUPABASE_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "Missing Supabase server configuration: SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required.",
    );
  }

  return { url, publishableKey };
}

export function createSupabaseServerClient(
  config: SupabaseServerConfig = readSupabaseServerConfig(),
): SupabaseClient {
  return createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export interface VerifiedUser {
  id: string;
  email: string | null;
}

type AccessTokenVerifierClient = {
  auth: Pick<SupabaseClient["auth"], "getUser">;
};

export async function verifyAccessToken(
  token: string | undefined | null,
  client: AccessTokenVerifierClient = createSupabaseServerClient(),
): Promise<VerifiedUser | null> {
  if (!token || token.trim() === "") {
    return null;
  }

  const { data, error } = await client.auth.getUser(token);

  if (error || !data.user) {
    return null;
  }

  return { id: data.user.id, email: data.user.email ?? null };
}
