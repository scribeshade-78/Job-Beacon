import { describe, expect, it, vi } from "vitest";
import { disconnectMailboxConnection, listMailboxConnections, startMailboxConnect } from "./mailbox";

describe("listMailboxConnections", () => {
  it("maps connection rows on success", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "conn-1",
          provider: "gmail",
          status: "connected",
          email_address: "candidate@gmail.com",
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
          emailAddress: "candidate@gmail.com",
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

describe("startMailboxConnect", () => {
  it("posts with a bearer token and returns the authorize URL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ authorizeUrl: "https://accounts.google.com/authorize?..." }) });

    const result = await startMailboxConnect("tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "success", authorizeUrl: "https://accounts.google.com/authorize?..." });
    expect(fetchImpl).toHaveBeenCalledWith("/api/mailbox/connect/start", {
      method: "POST",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns a generic error on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "boom" }) });
    const result = await startMailboxConnect("tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "error", message: "Could not start connecting your mailbox. Please try again." });
  });

  it("returns a network-error message when fetch itself throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await startMailboxConnect("tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});

describe("disconnectMailboxConnection", () => {
  it("posts to the connection's disconnect route with a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "conn-1" }) });

    const result = await disconnectMailboxConnection("conn-1", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "success" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/mailbox/conn-1/disconnect", {
      method: "POST",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns a generic error on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "not found" }) });
    const result = await disconnectMailboxConnection("conn-1", "tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "error", message: "Could not disconnect this mailbox. Please try again." });
  });

  it("returns a network-error message when fetch itself throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await disconnectMailboxConnection("conn-1", "tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});
