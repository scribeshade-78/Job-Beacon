import { describe, expect, it, vi } from "vitest";
import { listExclusions, setExclusion } from "./exclusions";

describe("listExclusions", () => {
  it("returns the caller's categories on success", async () => {
    const select = vi.fn().mockResolvedValue({
      data: [{ category: "staffing_agencies" }, { category: "relocation_required" }],
      error: null,
    });
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listExclusions>[0];

    const result = await listExclusions(client);

    expect(result).toEqual({ kind: "success", categories: ["staffing_agencies", "relocation_required"] });
  });

  it("returns a generic error and never the raw message on failure", async () => {
    const select = vi.fn().mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listExclusions>[0];

    const result = await listExclusions(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("relation");
    }
  });
});

describe("setExclusion", () => {
  it("inserts when enabling", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as Parameters<typeof setExclusion>[0];

    const result = await setExclusion(client, "candidate-1", "staffing_agencies", true);

    expect(result).toEqual({ kind: "success" });
    expect(insert).toHaveBeenCalledWith({ candidate_id: "candidate-1", category: "staffing_agencies" });
  });

  it("treats a duplicate insert (23505) as success, not an error", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as Parameters<typeof setExclusion>[0];

    const result = await setExclusion(client, "candidate-1", "staffing_agencies", true);

    expect(result).toEqual({ kind: "success" });
  });

  it("deletes when disabling", async () => {
    const eq2 = vi.fn().mockResolvedValue({ error: null });
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const del = vi.fn(() => ({ eq: eq1 }));
    const from = vi.fn(() => ({ delete: del }));
    const client = { from } as unknown as Parameters<typeof setExclusion>[0];

    const result = await setExclusion(client, "candidate-1", "staffing_agencies", false);

    expect(result).toEqual({ kind: "success" });
  });

  it("returns a generic error for a non-duplicate insert failure", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: "42501", message: "permission denied" } });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as Parameters<typeof setExclusion>[0];

    const result = await setExclusion(client, "candidate-1", "contract_roles", true);

    expect(result.kind).toBe("error");
  });
});
