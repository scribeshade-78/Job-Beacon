import { describe, expect, it, vi } from "vitest";
import { listSelectedRoles, removeRole, selectRole } from "./candidateSelectedRoles";

describe("listSelectedRoles", () => {
  it("returns the caller's roles on success", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [{ id: "role-1", role_name: "Software Engineer", created_at: "2026-08-24T00:00:00Z" }],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listSelectedRoles>[0];

    const result = await listSelectedRoles(client);

    expect(result).toEqual({
      kind: "success",
      roles: [{ id: "role-1", roleName: "Software Engineer", createdAt: "2026-08-24T00:00:00Z" }],
    });
  });

  it("returns a generic error and never the raw message on failure", async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listSelectedRoles>[0];

    const result = await listSelectedRoles(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("relation");
    }
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("boom");
    });
    const result = await listSelectedRoles({ from } as unknown as Parameters<typeof listSelectedRoles>[0]);

    expect(result.kind).toBe("error");
  });
});

describe("selectRole", () => {
  it("inserts the candidate id and role name", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as Parameters<typeof selectRole>[0];

    const result = await selectRole(client, "candidate-1", "Software Engineer");

    expect(result).toEqual({ kind: "success" });
    expect(insert).toHaveBeenCalledWith({ candidate_id: "candidate-1", role_name: "Software Engineer" });
  });

  it("treats a duplicate insert (23505) as success, not an error", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as Parameters<typeof selectRole>[0];

    const result = await selectRole(client, "candidate-1", "Software Engineer");

    expect(result).toEqual({ kind: "success" });
  });

  it("returns a generic error for a non-duplicate insert failure", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: "42501", message: "permission denied" } });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as Parameters<typeof selectRole>[0];

    const result = await selectRole(client, "candidate-1", "Software Engineer");

    expect(result.kind).toBe("error");
  });
});

describe("removeRole", () => {
  it("deletes by row id", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const del = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ delete: del }));
    const client = { from } as unknown as Parameters<typeof removeRole>[0];

    const result = await removeRole(client, "role-1");

    expect(result).toEqual({ kind: "success" });
    expect(eq).toHaveBeenCalledWith("id", "role-1");
  });

  it("returns a generic error on delete failure", async () => {
    const eq = vi.fn().mockResolvedValue({ error: { message: "permission denied" } });
    const del = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ delete: del }));
    const client = { from } as unknown as Parameters<typeof removeRole>[0];

    const result = await removeRole(client, "role-1");

    expect(result.kind).toBe("error");
  });
});
