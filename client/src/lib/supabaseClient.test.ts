import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSupabaseBrowserClient,
  readSupabaseBrowserConfig,
} from "./supabaseClient";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readSupabaseBrowserConfig", () => {
  it("throws when VITE_SUPABASE_URL is missing", () => {
    expect(() =>
      readSupabaseBrowserConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: "key" }),
    ).toThrow(/VITE_SUPABASE_URL/);
  });

  it("throws when VITE_SUPABASE_PUBLISHABLE_KEY is missing", () => {
    expect(() =>
      readSupabaseBrowserConfig({ VITE_SUPABASE_URL: "https://example.supabase.co" }),
    ).toThrow(/VITE_SUPABASE_PUBLISHABLE_KEY/);
  });

  it("returns the config when both variables are present", () => {
    const config = readSupabaseBrowserConfig({
      VITE_SUPABASE_URL: "https://example.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
    });

    expect(config).toEqual({
      url: "https://example.supabase.co",
      publishableKey: "publishable-key",
    });
  });
});

describe("createSupabaseBrowserClient", () => {
  it("constructs a client when configuration is valid", () => {
    const client = createSupabaseBrowserClient({
      url: "https://example.supabase.co",
      publishableKey: "publishable-key",
    });

    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
  });

  it("fails clearly when invoked with no config and the required variables are unset", () => {
    vi.stubEnv("VITE_SUPABASE_URL", undefined);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", undefined);

    expect(() => createSupabaseBrowserClient()).toThrow(
      /VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY/,
    );
  });
});
