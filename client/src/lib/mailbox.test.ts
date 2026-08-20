import { describe, expect, it, vi } from "vitest";
import { listMailboxConnections } from "./mailbox";

describe("listMailboxConnections", () => {
  it("maps connection rows on success", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "conn-1",
          provider: "gmail",
          status: "connected",
          connected_at: "2026-08-20T00:00:00Z",
          revoked_at: null,
          created_at: "2026-08-19T00:00:00Z",
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listMailboxConnections>[0];

    const result = await listMailboxConnections(client);

    expect(result).toEqual({
      kind: "success",
      connections: [
        {
          id: "conn-1",
          provider: "gmail",
          status: "connected",
          connectedAt: "2026-08-20T00:00:00Z",
          revokedAt: null,
          createdAt: "2026-08-19T00:00:00Z",
        },
      ],
    });
    expect(from).toHaveBeenCalledWith("mailbox_connections");
  });

  it("returns an empty list when the candidate has no mailbox connections", async () => {
    const order = vi.fn().mockResolvedValue({ data: [], error: null });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listMailboxConnections>[0];

    const result = await listMailboxConnections(client);

    expect(result).toEqual({ kind: "success", connections: [] });
  });

  it("returns a generic error and never the raw message on failure", async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listMailboxConnections>[0];

    const result = await listMailboxConnections(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("relation");
    }
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("network down");
    });
    const client = { from } as unknown as Parameters<typeof listMailboxConnections>[0];

    const result = await listMailboxConnections(client);

    expect(result).toEqual({
      kind: "error",
      message: "Could not load your mailbox connections. Please try again.",
    });
  });
});
