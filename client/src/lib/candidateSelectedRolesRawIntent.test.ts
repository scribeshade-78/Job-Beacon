import { describe, expect, it, vi } from "vitest";
import { listSelectedRoles, selectRole } from "./candidateSelectedRoles";

/**
 * Raw intent through save and reload.
 *
 * MOCKED CLIENT, NOT DATABASE VALIDATION: the uniqueness constraint and RLS are
 * asserted as EMITTED payloads and simulated 23505 responses, never executed.
 */

function insertClient(result: { error?: unknown } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates = vi.fn();

  const client = {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserts.push(row);
        return { error: result.error ?? null };
      },
      update: updates,
    }),
  };

  return { client: client as never, inserts, updates };
}

function listClient(rows: unknown, error: unknown = null) {
  const selected: string[] = [];
  const client = {
    from: () => ({
      select: (columns: string) => {
        selected.push(columns);
        return { order: async () => ({ data: rows, error }) };
      },
    }),
  };
  return { client: client as never, selected };
}

describe("selectRole raw intent", () => {
  it("writes the confirmed phrase and the catalog id alongside role_name", async () => {
    const { client, inserts } = insertClient();

    const result = await selectRole(client, "candidate-1", "Data Engineer", {
      rawRoleName: "Azure Data Engineer",
      normalizedRoleId: "data-engineer",
    });

    expect(result).toEqual({ kind: "success" });
    expect(inserts[0]).toEqual({
      candidate_id: "candidate-1",
      // role_name is unchanged: every established matcher still reads it.
      role_name: "Data Engineer",
      raw_role_name: "Azure Data Engineer",
      normalized_role_id: "data-engineer",
    });
  });

  it("stores an absent phrase as NULL rather than inventing one", async () => {
    const { client, inserts } = insertClient();

    await selectRole(client, "candidate-1", "Nurse");

    expect(inserts[0].raw_role_name).toBeNull();
    expect(inserts[0].normalized_role_id).toBeNull();
  });

  it("normalises a blank phrase to NULL", async () => {
    const { client, inserts } = insertClient();

    await selectRole(client, "candidate-1", "Nurse", { rawRoleName: "   " });

    expect(inserts[0].raw_role_name).toBeNull();
  });

  it("supports a custom role: no catalog id, the candidate's own words kept", async () => {
    const { client, inserts } = insertClient();

    await selectRole(client, "candidate-1", "Marine Biologist", {
      rawRoleName: "Marine Biologist",
      normalizedRoleId: null,
    });

    expect(inserts[0].role_name).toBe("Marine Biologist");
    expect(inserts[0].normalized_role_id).toBeNull();
  });

  it("does NOT overwrite previously recorded intent on an existing selection", async () => {
    const { client, inserts, updates } = insertClient({ error: { code: "23505" } });

    const result = await selectRole(client, "candidate-1", "Data Engineer", {
      // A later, generic search phrase must not replace the earlier real intent.
      rawRoleName: "data",
    });

    expect(result).toEqual({ kind: "success" });
    expect(inserts).toHaveLength(1);
    // No UPDATE is issued at all: the unique key cannot hold two intents for one
    // role, so the recorded one stands.
    expect(updates).not.toHaveBeenCalled();
  });

  it("reports a failure rather than success when the write fails", async () => {
    const { client } = insertClient({ error: { code: "42501", message: "row-level security" } });

    const result = await selectRole(client, "candidate-1", "Nurse");

    expect(result).toEqual({ kind: "error", message: "Could not update your target roles. Please try again." });
  });
});

describe("listSelectedRoles raw intent", () => {
  it("selects the new columns and maps a recorded phrase", async () => {
    const { client, selected } = listClient([
      {
        id: "r1",
        role_name: "Data Engineer",
        raw_role_name: "Azure Data Engineer",
        normalized_role_id: "data-engineer",
        created_at: "2026-10-01T00:00:00Z",
      },
    ]);

    const result = await listSelectedRoles(client);

    expect(selected[0]).toContain("raw_role_name");
    expect(selected[0]).toContain("normalized_role_id");
    expect(result).toEqual({
      kind: "success",
      roles: [
        {
          id: "r1",
          roleName: "Data Engineer",
          rawRoleName: "Azure Data Engineer",
          normalizedRoleId: "data-engineer",
          createdAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
  });

  it("keeps a legacy row's raw intent UNKNOWN instead of reconstructing it", async () => {
    const { client } = listClient([
      {
        id: "r2",
        role_name: "Data Engineer",
        raw_role_name: null,
        normalized_role_id: null,
        created_at: "2026-08-01T00:00:00Z",
      },
    ]);

    const result = await listSelectedRoles(client);

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    // Not "Data Engineer": we never recorded what they asked for, and pretending
    // role_name was their phrase would be inventing intent.
    expect(result.roles[0].rawRoleName).toBeNull();
    expect(result.roles[0].normalizedRoleId).toBeNull();
    expect(result.roles[0].roleName).toBe("Data Engineer");
  });

  it("fails loudly instead of silently dropping metadata", async () => {
    const { client } = listClient(null, { message: 'column "raw_role_name" does not exist' });

    const result = await listSelectedRoles(client);

    expect(result).toEqual({ kind: "error", message: "Could not load your target roles. Please try again." });
  });
});
