import { describe, expect, it, vi } from "vitest";
import { revokeOtherSessions } from "./session";

describe("revokeOtherSessions", () => {
  it("signs out with scope 'others', keeping the current session alive", async () => {
    const signOut = vi.fn().mockResolvedValue({ error: null });
    const client = { auth: { signOut } } as unknown as Parameters<typeof revokeOtherSessions>[0];

    const result = await revokeOtherSessions(client);

    expect(result).toEqual({ kind: "success" });
    expect(signOut).toHaveBeenCalledWith({ scope: "others" });
  });

  it("returns a generic error and never the raw message on failure", async () => {
    const signOut = vi.fn().mockResolvedValue({ error: { message: "internal token store failure at node-7" } });
    const client = { auth: { signOut } } as unknown as Parameters<typeof revokeOtherSessions>[0];

    const result = await revokeOtherSessions(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("node-7");
    }
  });

  it("returns a generic error when the call throws", async () => {
    const signOut = vi.fn().mockRejectedValue(new Error("network down"));
    const client = { auth: { signOut } } as unknown as Parameters<typeof revokeOtherSessions>[0];

    const result = await revokeOtherSessions(client);

    expect(result.kind).toBe("error");
  });
});
