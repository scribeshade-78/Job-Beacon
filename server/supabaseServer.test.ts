import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  createSupabaseServerClient,
  readSupabaseServerConfig,
  verifyAccessToken,
} from "./supabaseServer.js";

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return {
    ...actual,
    createClient: vi.fn(actual.createClient),
  };
});

describe("readSupabaseServerConfig", () => {
  it("throws when SUPABASE_URL is missing", () => {
    expect(() =>
      readSupabaseServerConfig({ SUPABASE_PUBLISHABLE_KEY: "key" }),
    ).toThrow(/SUPABASE_URL/);
  });

  it("throws when SUPABASE_PUBLISHABLE_KEY is missing", () => {
    expect(() =>
      readSupabaseServerConfig({ SUPABASE_URL: "https://example.supabase.co" }),
    ).toThrow(/SUPABASE_PUBLISHABLE_KEY/);
  });

  it("returns the config when both variables are present", () => {
    const config = readSupabaseServerConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "publishable-key",
    });

    expect(config).toEqual({
      url: "https://example.supabase.co",
      publishableKey: "publishable-key",
    });
  });
});

describe("createSupabaseServerClient", () => {
  it("constructs a client when configuration is valid", () => {
    const client = createSupabaseServerClient({
      url: "https://example.supabase.co",
      publishableKey: "publishable-key",
    });

    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
  });

  it("disables session persistence, auto-refresh, and URL session detection", () => {
    createSupabaseServerClient({
      url: "https://example.supabase.co",
      publishableKey: "publishable-key",
    });

    expect(createClient).toHaveBeenLastCalledWith(
      "https://example.supabase.co",
      "publishable-key",
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
  });

  it("fails clearly when invoked with no config and no environment variables set", () => {
    const originalUrl = process.env.SUPABASE_URL;
    const originalKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_PUBLISHABLE_KEY;

    try {
      expect(() => createSupabaseServerClient()).toThrow(
        /SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY/,
      );
    } finally {
      if (originalUrl !== undefined) process.env.SUPABASE_URL = originalUrl;
      if (originalKey !== undefined) process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
    }
  });
});

describe("verifyAccessToken", () => {
  it("rejects a missing token without calling the client", async () => {
    const getUser = vi.fn();

    const result = await verifyAccessToken(undefined, { auth: { getUser } });

    expect(result).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("rejects an empty token without calling the client", async () => {
    const getUser = vi.fn();

    const result = await verifyAccessToken("   ", { auth: { getUser } });

    expect(result).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("returns the verified user for a mocked successful getUser response", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: { id: "user-123", email: "person@example.com" } },
      error: null,
    });

    const result = await verifyAccessToken("valid-token", { auth: { getUser } });

    expect(result).toEqual({ id: "user-123", email: "person@example.com" });
    expect(getUser).toHaveBeenCalledWith("valid-token");
  });

  it("returns null for a mocked failed getUser response", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: null },
      error: { message: "invalid token" },
    });

    const result = await verifyAccessToken("bad-token", { auth: { getUser } });

    expect(result).toBeNull();
  });
});
