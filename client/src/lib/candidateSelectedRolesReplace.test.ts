import { describe, expect, it, vi } from "vitest";
import { replaceRoleIntent } from "./candidateSelectedRoles";

/**
 * Deliberate intent replacement.
 *
 * MOCKED CLIENT: the emitted update and its scoping are asserted, not RLS.
 */

function makeClient(result: { error?: unknown } = {}) {
  const payloads: Array<Record<string, unknown>> = [];
  const filters: Array<[string, unknown]> = [];
  const updates = vi.fn((payload: Record<string, unknown>) => {
    payloads.push(payload);
    return builder;
  });

  const builder: any = {
    update: updates,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };

  const client = { from: vi.fn(() => builder) } as never;
  return { client, payloads, filters, updates };
}

describe("replaceRoleIntent", () => {
  it("replaces the recorded phrase by row id, without touching role_name", async () => {
    const { client, payloads, filters } = makeClient({ error: null });

    const result = await replaceRoleIntent(client, "role-1", {
      rawRoleName: "Azure Data Engineer",
      normalizedRoleId: "data-engineer",
    });

    expect(result).toEqual({ kind: "success" });
    expect(payloads[0]).toEqual({
      raw_role_name: "Azure Data Engineer",
      normalized_role_id: "data-engineer",
    });
    // role_name is deliberately absent: this changes the REQUESTED PHRASE, not
    // the occupation the candidate selected.
    expect(payloads[0]).not.toHaveProperty("role_name");
    // Scoped by primary key; candidate_selected_roles_update_own then scopes it
    // to the caller's own rows, so no extra policy is needed.
    expect(filters).toEqual([["id", "role-1"]]);
  });

  it("can clear a phrase back to not-recorded", async () => {
    const { client, payloads } = makeClient({ error: null });

    await replaceRoleIntent(client, "role-1", { rawRoleName: "   ", normalizedRoleId: null });

    expect(payloads[0].raw_role_name).toBeNull();
    expect(payloads[0].normalized_role_id).toBeNull();
  });

  it("reports a failure rather than success when the update fails", async () => {
    const { client } = makeClient({ error: { message: "permission denied" } });

    const result = await replaceRoleIntent(client, "role-1", { rawRoleName: "Azure Data Engineer" });

    expect(result).toEqual({ kind: "error", message: "Could not update your target roles. Please try again." });
  });

  it("does not claim success when the client throws", async () => {
    const client = {
      from: () => {
        throw new Error("offline");
      },
    } as never;

    const result = await replaceRoleIntent(client, "role-1", { rawRoleName: "Azure" });

    expect(result.kind).toBe("error");
  });
});
