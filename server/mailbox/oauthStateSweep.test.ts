import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OAUTH_STATE_SWEEP_GRACE, runOAuthStateSweep } from "./oauthStateSweep.js";

function makeClient(data: unknown, error: unknown = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("runOAuthStateSweep", () => {
  it("calls the SQL invariant with the default grace window and returns the purged count", async () => {
    const { client, rpc } = makeClient(3);

    const result = await runOAuthStateSweep(client);

    expect(rpc).toHaveBeenCalledWith("purge_expired_oauth_state", {
      grace_interval: DEFAULT_OAUTH_STATE_SWEEP_GRACE,
    });
    expect(result).toEqual({ purged: 3, grace: DEFAULT_OAUTH_STATE_SWEEP_GRACE });
  });

  it("passes an explicit grace window through, so the window is a decision and not a constant", async () => {
    const { client, rpc } = makeClient(0);

    const result = await runOAuthStateSweep(client, { grace: "2 hours" });

    expect(rpc).toHaveBeenCalledWith("purge_expired_oauth_state", { grace_interval: "2 hours" });
    expect(result).toEqual({ purged: 0, grace: "2 hours" });
  });

  it("throws when the RPC fails rather than reporting a successful empty sweep", async () => {
    const { client } = makeClient(null, { message: "function does not exist" });

    await expect(runOAuthStateSweep(client)).rejects.toEqual({ message: "function does not exist" });
  });

  it("throws on a non-integer row count, because inventing zero would claim a sweep that never happened", async () => {
    const { client } = makeClient({ unexpected: true });

    await expect(runOAuthStateSweep(client)).rejects.toThrow(/non-integer row count/);
  });
});
