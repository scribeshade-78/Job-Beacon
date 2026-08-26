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

export type AuthenticatorAssuranceLevel = "aal1" | "aal2";

export interface VerifiedUser {
  id: string;
  email: string | null;
  /** R5.4a: PRD §20.1 "MFA-protected employer account" — requireEmployer.ts's AAL2 gate reads this. */
  aal: AuthenticatorAssuranceLevel;
}

type AccessTokenVerifierClient = {
  auth: Pick<SupabaseClient["auth"], "getUser">;
};

/**
 * Reads the `aal` claim directly off the JWT payload rather than calling a
 * separate Supabase endpoint — getUser() above already cryptographically
 * verified this exact token against Supabase's server, so decoding its
 * already-trusted payload for one more claim needs no extra network call
 * and no new dependency (stdlib base64url decode only). Any decode failure
 * (malformed token, missing claim) defaults to 'aal1' — fail-closed, since
 * this gates elevated (employer) access, never fail-open to 'aal2'.
 */
function decodeAal(token: string): AuthenticatorAssuranceLevel {
  try {
    const payloadSegment = token.split(".")[1];

    if (!payloadSegment) {
      return "aal1";
    }

    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as { aal?: string };
    return payload.aal === "aal2" ? "aal2" : "aal1";
  } catch {
    return "aal1";
  }
}

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

  return { id: data.user.id, email: data.user.email ?? null, aal: decodeAal(token) };
}
