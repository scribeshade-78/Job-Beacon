import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient, readSupabaseServiceRoleConfig } from "./supabaseServiceRole.js";

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return {
    ...actual,
    createClient: vi.fn(actual.createClient),
  };
});

describe("readSupabaseServiceRoleConfig", () => {
  it("throws when SUPABASE_URL is missing", () => {
    expect(() =>
      readSupabaseServiceRoleConfig({ SUPABASE_SERVICE_ROLE_KEY: "key" }),
    ).toThrow(/SUPABASE_URL/);
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    expect(() =>
      readSupabaseServiceRoleConfig({ SUPABASE_URL: "https://example.supabase.co" }),
    ).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("returns the config when both variables are present", () => {
    const config = readSupabaseServiceRoleConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    });

    expect(config).toEqual({
      url: "https://example.supabase.co",
      serviceRoleKey: "service-role-key",
    });
  });
});

describe("createSupabaseServiceRoleClient", () => {
  it("constructs a client when configuration is valid", () => {
    const client = createSupabaseServiceRoleClient({
      url: "https://example.supabase.co",
      serviceRoleKey: "service-role-key",
    });

    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
  });

  it("disables session persistence, auto-refresh, and URL session detection", () => {
    createSupabaseServiceRoleClient({
      url: "https://example.supabase.co",
      serviceRoleKey: "service-role-key",
    });

    expect(createClient).toHaveBeenLastCalledWith(
      "https://example.supabase.co",
      "service-role-key",
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
    const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    try {
      expect(() => createSupabaseServiceRoleClient()).toThrow(
        /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/,
      );
    } finally {
      if (originalUrl !== undefined) process.env.SUPABASE_URL = originalUrl;
      if (originalKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    }
  });
});
