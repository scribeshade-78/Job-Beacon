/**
 * R6.1: Google OAuth2 + userinfo, via plain fetch — same "no SDK for a
 * stable REST API" convention server/companies/mcaRegistry.ts already
 * uses. googleapis is a large multi-service SDK; R6.1 only needs three
 * well-documented REST calls (authorize URL, token exchange, revoke), not
 * a typed client for every Google API.
 */
export type FetchImpl = typeof fetch;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function readGoogleOAuthConfig(env: Record<string, string | undefined> = process.env): GoogleOAuthConfig {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Missing Google OAuth configuration: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI are required.",
    );
  }

  return { clientId, clientSecret, redirectUri };
}

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/**
 * Requested now even though the R6.2 message-polling worker that actually
 * reads mail doesn't exist yet, so a candidate never has to re-consent
 * later — mailbox_connections.granted_scopes exists exactly for this.
 */
export const GOOGLE_MAILBOX_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"] as const;

export function buildGoogleAuthorizeUrl(config: GoogleOAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_MAILBOX_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline"); // required for a refresh_token
  url.searchParams.set("prompt", "consent"); // forces a fresh refresh_token on every connect, not just the first-ever grant
  url.searchParams.set("state", state);

  return url.toString();
}

export interface GoogleTokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

export class GoogleOAuthError extends Error {}

/** Shape of the JSON stored (encrypted) in mailbox_connections.secret_manager_key — shared by connect.ts (writes it) and poll.ts (reads/refreshes it). */
export interface StoredMailboxTokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export async function exchangeGoogleAuthCode(
  config: GoogleOAuthConfig,
  code: string,
  fetchImpl: FetchImpl = fetch,
): Promise<GoogleTokenBundle> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new GoogleOAuthError(`Google token exchange failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!body.access_token || !body.refresh_token || typeof body.expires_in !== "number") {
    // access_type=offline + prompt=consent above guarantee a refresh_token on
    // every exchange — its absence means Google's response shape changed,
    // not a legitimate no-refresh-token case.
    throw new GoogleOAuthError("Google token exchange response missing access_token, refresh_token, or expires_in.");
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope ?? "",
  };
}

export async function fetchGoogleEmailAddress(accessToken: string, fetchImpl: FetchImpl = fetch): Promise<string> {
  const response = await fetchImpl(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new GoogleOAuthError(`Google userinfo fetch failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as { email?: string };

  if (!body.email) {
    throw new GoogleOAuthError("Google userinfo response missing email.");
  }

  return body.email;
}

/** invalid_grant means the refresh token itself is dead (candidate revoked access outside our flow, or it expired) — retrying can never succeed; the caller must treat this as terminal, not backed off. */
export class GoogleRefreshTokenInvalidError extends GoogleOAuthError {}

export interface RefreshedGoogleAccessToken {
  accessToken: string;
  expiresAt: number;
}

export async function refreshGoogleAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<RefreshedGoogleAccessToken> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    let errorCode: string | undefined;

    try {
      const errorBody = (await response.json()) as { error?: string };
      errorCode = errorBody.error;
    } catch {
      // Response body wasn't usable JSON — fall through to the generic (retryable) error below.
    }

    if (errorCode === "invalid_grant") {
      throw new GoogleRefreshTokenInvalidError("Google rejected the refresh token (invalid_grant).");
    }

    throw new GoogleOAuthError(`Google token refresh failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };

  if (!body.access_token || typeof body.expires_in !== "number") {
    throw new GoogleOAuthError("Google token refresh response missing access_token or expires_in.");
  }

  return { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
}

/**
 * Best-effort: whether Google's revoke succeeds or fails, the caller always
 * marks the connection revoked locally regardless — a candidate's ability
 * to disconnect must not depend on Google's endpoint being reachable.
 */
export async function revokeGoogleToken(token: string, fetchImpl: FetchImpl = fetch): Promise<void> {
  try {
    await fetchImpl(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Swallowed deliberately — see the doc comment above.
  }
}
