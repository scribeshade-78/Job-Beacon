import { describe, expect, it, vi } from "vitest";
import { authorize, CONSENT_VERSION, getAuthorization, pause, resume, stop } from "./automationAuthorization";

describe("getAuthorization", () => {
  it("returns notYetAuthorized when no row exists", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof getAuthorization>[0];

    const result = await getAuthorization(client);

    expect(result).toEqual({ kind: "notYetAuthorized" });
  });

  it("returns the authorization when a row exists", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        status: "authorized",
        consent_version: "r1-v1",
        created_at: "2026-08-13T00:00:00Z",
        status_changed_at: "2026-08-13T00:00:00Z",
      },
      error: null,
    });
    const select = vi.fn(() => ({ maybeSingle }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof getAuthorization>[0];

    const result = await getAuthorization(client);

    expect(result.kind).toBe("authorized");
    if (result.kind === "authorized") {
      expect(result.authorization.status).toBe("authorized");
    }
  });

  it("returns a generic error and never the raw message on failure", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const select = vi.fn(() => ({ maybeSingle }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof getAuthorization>[0];

    const result = await getAuthorization(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("relation");
    }
  });
});

describe("authorize", () => {
  it("inserts with the current consent version", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as Parameters<typeof authorize>[0];

    const result = await authorize(client, "candidate-1");

    expect(result).toEqual({ kind: "success" });
    expect(insert).toHaveBeenCalledWith({
      candidate_id: "candidate-1",
      status: "authorized",
      consent_version: CONSENT_VERSION,
    });
  });

  it("treats a 23505 unique-violation as already-authorized, not an error", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as Parameters<typeof authorize>[0];

    const result = await authorize(client, "candidate-1");

    expect(result).toEqual({ kind: "success" });
  });

  it("returns a generic error for a non-duplicate insert failure", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: "42501", message: "permission denied" } });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as Parameters<typeof authorize>[0];

    const result = await authorize(client, "candidate-1");

    expect(result.kind).toBe("error");
  });
});

describe("pause/resume/stop", () => {
  // PostgREST rejects UPDATE with no WHERE clause outright (error 21000) —
  // asserting .eq() was called with the candidate's own id is what would
  // have caught the earlier bug where this filter was missing entirely.
  function createUpdateClient() {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    return { from: from as unknown as Parameters<typeof pause>[0]["from"], update, eq };
  }

  it("pause sets status to paused, scoped to the caller's own row", async () => {
    const { from, update, eq } = createUpdateClient();
    const result = await pause({ from } as Parameters<typeof pause>[0], "candidate-1");

    expect(result).toEqual({ kind: "success" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }));
    expect(eq).toHaveBeenCalledWith("candidate_id", "candidate-1");
  });

  it("resume sets status back to authorized, scoped to the caller's own row", async () => {
    const { from, update, eq } = createUpdateClient();
    const result = await resume({ from } as Parameters<typeof resume>[0], "candidate-1");

    expect(result).toEqual({ kind: "success" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "authorized" }));
    expect(eq).toHaveBeenCalledWith("candidate_id", "candidate-1");
  });

  it("stop sets status to stopped, scoped to the caller's own row", async () => {
    const { from, update, eq } = createUpdateClient();
    const result = await stop({ from } as Parameters<typeof stop>[0], "candidate-1");

    expect(result).toEqual({ kind: "success" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "stopped" }));
    expect(eq).toHaveBeenCalledWith("candidate_id", "candidate-1");
  });
});
