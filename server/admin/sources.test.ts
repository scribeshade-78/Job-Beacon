import { describe, expect, it, vi } from "vitest";
import { listSourcePolicies, updateSourcePolicy, SourcePolicyNotFoundError } from "./sources.js";

const sampleRow = {
  source_code: "greenhouse",
  discovery_allowed: true,
  storage_allowed: true,
  display_allowed: true,
  automated_application_allowed: false,
  authentication_method: "none",
  rate_limit: null,
  countries: ["US"],
  policy_version: "r2-v1",
  last_legal_review_at: null,
  kill_switch: false,
  created_at: "2026-08-13T00:00:00Z",
  updated_at: "2026-08-13T00:00:00Z",
};

describe("listSourcePolicies", () => {
  it("returns rows ordered by source_code", async () => {
    const from = vi.fn(() => ({
      select: () => ({ order: () => ({ data: [sampleRow], error: null }) }),
    }));
    const client = { from } as unknown as Parameters<typeof listSourcePolicies>[0];

    await expect(listSourcePolicies(client)).resolves.toEqual([sampleRow]);
  });

  it("returns an empty array when there are no rows", async () => {
    const from = vi.fn(() => ({ select: () => ({ order: () => ({ data: null, error: null }) }) }));
    const client = { from } as unknown as Parameters<typeof listSourcePolicies>[0];

    await expect(listSourcePolicies(client)).resolves.toEqual([]);
  });

  it("throws when the query errors", async () => {
    const from = vi.fn(() => ({ select: () => ({ order: () => ({ data: null, error: { message: "db error" } }) }) }));
    const client = { from } as unknown as Parameters<typeof listSourcePolicies>[0];

    await expect(listSourcePolicies(client)).rejects.toBeTruthy();
  });
});

describe("updateSourcePolicy", () => {
  function makeClient(result: { data: unknown; error: unknown }) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const builder = {
      update: (...args: unknown[]) => (calls.push({ method: "update", args }), builder),
      eq: (...args: unknown[]) => (calls.push({ method: "eq", args }), builder),
      select: (...args: unknown[]) => (calls.push({ method: "select", args }), builder),
      maybeSingle: async () => result,
    };
    return { client: { from: vi.fn(() => builder) } as unknown as Parameters<typeof updateSourcePolicy>[0], calls };
  }

  it("returns the updated row and stamps updated_at", async () => {
    const { client, calls } = makeClient({ data: { ...sampleRow, kill_switch: true }, error: null });

    const result = await updateSourcePolicy(client, "greenhouse", { kill_switch: true });

    expect(result.kill_switch).toBe(true);
    const updateCall = calls.find((call) => call.method === "update");
    expect(updateCall?.args[0]).toMatchObject({ kill_switch: true });
    expect((updateCall?.args[0] as { updated_at: string }).updated_at).toBeTruthy();
    const eqCall = calls.find((call) => call.method === "eq");
    expect(eqCall?.args).toEqual(["source_code", "greenhouse"]);
  });

  it("throws SourcePolicyNotFoundError when no row matches", async () => {
    const { client } = makeClient({ data: null, error: null });

    await expect(updateSourcePolicy(client, "does-not-exist", { kill_switch: true })).rejects.toBeInstanceOf(
      SourcePolicyNotFoundError,
    );
  });

  it("throws when the query errors", async () => {
    const { client } = makeClient({ data: null, error: { message: "db error" } });

    await expect(updateSourcePolicy(client, "greenhouse", { kill_switch: true })).rejects.toBeTruthy();
  });
});
