import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { loadLocationOptions } from "./locationOptions.js";

function clientReturning(data: unknown, error: unknown = null): SupabaseClient {
  return { rpc: vi.fn(async () => ({ data, error })) } as unknown as SupabaseClient;
}

describe("loadLocationOptions", () => {
  it("reads the countries and cities the RPC returns", async () => {
    const options = await loadLocationOptions(
      clientReturning({ countries: ["GB"], cities: ["Belfast", "Cardiff County"] }),
    );

    expect(options).toEqual({ countries: ["GB"], cities: ["Belfast", "Cardiff County"] });
  });

  it("returns empty lists rather than throwing when there is nothing yet", async () => {
    // A fresh deployment has no structured locations at all. The picker must render as
    // "nothing to choose yet", not as a failed request.
    expect(await loadLocationOptions(clientReturning({ countries: [], cities: [] }))).toEqual({
      countries: [],
      cities: [],
    });
    expect(await loadLocationOptions(clientReturning(null))).toEqual({ countries: [], cities: [] });
  });

  it("DROPS anything that is not a usable string, rather than passing it to the UI", async () => {
    // A blank option would render as an unnamed row that filters to nothing - the
    // silent no-op this whole proposal exists to remove. Numbers and nulls likewise.
    const options = await loadLocationOptions(
      clientReturning({ countries: ["GB", "", "   ", null, 7, "US"], cities: [null, "Belfast", ""] }),
    );

    expect(options.countries).toEqual(["GB", "US"]);
    expect(options.cities).toEqual(["Belfast"]);
  });

  it("PROPAGATES a database error instead of reporting an empty world", async () => {
    // "We could not read the options" and "there are no options" are different
    // statements, and collapsing them would tell a candidate their country is
    // unavailable when in fact the query failed.
    await expect(
      loadLocationOptions(clientReturning(null, { message: "connection reset" })),
    ).rejects.toThrow(/connection reset/);
  });
});
