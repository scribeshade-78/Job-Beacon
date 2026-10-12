import { describe, expect, it, vi } from "vitest";

vi.mock("./supabaseClient", () => ({
  getSupabaseBrowserClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "token" } } }) },
  }),
}));

import { fetchLocationOptions } from "./locationOptions";

const ok = (body: unknown) =>
  (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

describe("fetchLocationOptions", () => {
  it("returns the countries and cities the endpoint reports", async () => {
    const options = await fetchLocationOptions(ok({ countries: ["GB", "US"], cities: ["Belfast"] }));

    expect(options).toEqual({ countries: ["GB", "US"], cities: ["Belfast"] });
  });

  it("surfaces a failure rather than pretending there are no options", async () => {
    // An empty picker and a broken request look identical on screen, and only one of
    // them is the candidate's problem to reason about.
    const failing = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;

    await expect(fetchLocationOptions(failing)).rejects.toThrow(/HTTP 500/);
  });

  it("drops unusable entries the same way the server does", async () => {
    const options = await fetchLocationOptions(ok({ countries: ["GB", "", null, 3], cities: null }));

    expect(options.countries).toEqual(["GB"]);
    expect(options.cities).toEqual([]);
  });
});
