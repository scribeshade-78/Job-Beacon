import { describe, expect, it, vi } from "vitest";
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleAuthCode,
  fetchGoogleEmailAddress,
  GoogleOAuthError,
  GoogleRefreshTokenInvalidError,
  readGoogleOAuthConfig,
  refreshGoogleAccessToken,
  revokeGoogleToken,
  type FetchImpl,
} from "./oauth.js";

const CONFIG = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://app.example/api/mailbox/oauth/callback",
};

function mockFetch(response: Partial<Response> & { ok: boolean }): FetchImpl {
  return vi.fn(async () => response as Response);
}

describe("readGoogleOAuthConfig", () => {
  it("reads all three vars", () => {
    expect(
      readGoogleOAuthConfig({
        GOOGLE_OAUTH_CLIENT_ID: "id",
        GOOGLE_OAUTH_CLIENT_SECRET: "secret",
        GOOGLE_OAUTH_REDIRECT_URI: "uri",
      }),
    ).toEqual({ clientId: "id", clientSecret: "secret", redirectUri: "uri" });
  });

  it("throws when any var is missing", () => {
    expect(() => readGoogleOAuthConfig({})).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });
});

describe("buildGoogleAuthorizeUrl", () => {
  it("includes the requested scopes, offline access, forced consent, and state", () => {
    const url = new URL(buildGoogleAuthorizeUrl(CONFIG, "signed-state"));

    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
  });
});

describe("exchangeGoogleAuthCode", () => {
  it("returns a token bundle on success", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "a b" }),
    });

    const result = await exchangeGoogleAuthCode(CONFIG, "auth-code", fetchImpl);

    expect(result.accessToken).toBe("at");
    expect(result.refreshToken).toBe("rt");
    expect(result.scope).toBe("a b");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("throws GoogleOAuthError on a non-ok response", async () => {
    const fetchImpl = mockFetch({ ok: false, status: 400, json: async () => ({}) });
    await expect(exchangeGoogleAuthCode(CONFIG, "bad-code", fetchImpl)).rejects.toBeInstanceOf(GoogleOAuthError);
  });

  it("throws GoogleOAuthError when refresh_token is missing", async () => {
    const fetchImpl = mockFetch({ ok: true, json: async () => ({ access_token: "at", expires_in: 3600 }) });
    await expect(exchangeGoogleAuthCode(CONFIG, "auth-code", fetchImpl)).rejects.toBeInstanceOf(GoogleOAuthError);
  });
});

describe("fetchGoogleEmailAddress", () => {
  it("returns the email on success", async () => {
    const fetchImpl = mockFetch({ ok: true, json: async () => ({ email: "candidate@gmail.com" }) });
    expect(await fetchGoogleEmailAddress("at", fetchImpl)).toBe("candidate@gmail.com");
  });

  it("throws GoogleOAuthError when the response has no email", async () => {
    const fetchImpl = mockFetch({ ok: true, json: async () => ({}) });
    await expect(fetchGoogleEmailAddress("at", fetchImpl)).rejects.toBeInstanceOf(GoogleOAuthError);
  });
});

describe("refreshGoogleAccessToken", () => {
  it("returns a new access token and expiry on success", async () => {
    const fetchImpl = mockFetch({ ok: true, json: async () => ({ access_token: "new-at", expires_in: 3600 }) });

    const result = await refreshGoogleAccessToken(CONFIG, "rt", fetchImpl);

    expect(result.accessToken).toBe("new-at");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("throws GoogleRefreshTokenInvalidError on invalid_grant", async () => {
    const fetchImpl = mockFetch({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });
    await expect(refreshGoogleAccessToken(CONFIG, "rt", fetchImpl)).rejects.toBeInstanceOf(GoogleRefreshTokenInvalidError);
  });

  it("throws a plain GoogleOAuthError (not the invalid-grant subtype) for other failures", async () => {
    const fetchImpl = mockFetch({ ok: false, status: 500, json: async () => ({ error: "server_error" }) });
    const promise = refreshGoogleAccessToken(CONFIG, "rt", fetchImpl);
    await expect(promise).rejects.toBeInstanceOf(GoogleOAuthError);
    await expect(promise).rejects.not.toBeInstanceOf(GoogleRefreshTokenInvalidError);
  });

  it("throws GoogleOAuthError when the response has no access_token", async () => {
    const fetchImpl = mockFetch({ ok: true, json: async () => ({ expires_in: 3600 }) });
    await expect(refreshGoogleAccessToken(CONFIG, "rt", fetchImpl)).rejects.toBeInstanceOf(GoogleOAuthError);
  });
});

describe("revokeGoogleToken", () => {
  it("never throws, even if the network call rejects", async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(revokeGoogleToken("at", fetchImpl)).resolves.toBeUndefined();
  });
});
