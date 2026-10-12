import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { ensureCandidateProfile } from "./profile";

function createMockClient(insertImpl: ReturnType<typeof vi.fn>) {
  const from = vi.fn(() => ({ insert: insertImpl }));
  return { from } as unknown as Pick<SupabaseClient, "from">;
}

describe("ensureCandidateProfile", () => {
  it("returns ready on a successful first insert", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const client = createMockClient(insert);

    const result = await ensureCandidateProfile(client, "user-1");

    expect(result).toEqual({ kind: "ready" });
    expect(insert).toHaveBeenCalledWith({ id: "user-1" });
  });

  it("treats a 23505 unique-violation as already-ready, not an error", async () => {
    const insert = vi.fn().mockResolvedValue({
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    const client = createMockClient(insert);

    const result = await ensureCandidateProfile(client, "user-1");

    expect(result).toEqual({ kind: "ready" });
  });

  it("returns a safe generic failure for any other error, never the raw message", async () => {
    const insert = vi.fn().mockResolvedValue({
      error: { code: "42501", message: "permission denied for table candidate_profiles" },
    });
    const client = createMockClient(insert);

    const result = await ensureCandidateProfile(client, "user-1");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("permission denied");
      expect(result.message).not.toContain("candidate_profiles");
      expect(result.message).not.toContain("42501");
    }
  });

  it("returns the same generic failure for a thrown/rejected network error as for a resolved non-23505 error", async () => {
    const resolvedErrorInsert = vi.fn().mockResolvedValue({
      error: { code: "42501", message: "permission denied for table candidate_profiles" },
    });
    const rejectedInsert = vi.fn().mockRejectedValue(new Error("network down"));

    const resolvedResult = await ensureCandidateProfile(createMockClient(resolvedErrorInsert), "user-1");
    const rejectedResult = await ensureCandidateProfile(createMockClient(rejectedInsert), "user-1");

    expect(resolvedResult.kind).toBe("error");
    expect(rejectedResult.kind).toBe("error");
    if (resolvedResult.kind === "error" && rejectedResult.kind === "error") {
      // Same shared constant, not two independently-worded messages.
      expect(rejectedResult.message).toBe(resolvedResult.message);
    }
  });

  it("does not expose the thrown error's message, stack, or identity when the insert call rejects", async () => {
    const thrown = new Error("ECONNRESET: socket hang up at 10.0.0.5:5432");
    const insert = vi.fn().mockRejectedValue(thrown);
    const client = createMockClient(insert);

    const result = await ensureCandidateProfile(client, "user-1");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("ECONNRESET");
      expect(result.message).not.toContain("10.0.0.5");
      expect(result.message).not.toContain(thrown.message);
    }
  });

  it("never logs a rejected insert's error object, message, or stack", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const insert = vi.fn().mockRejectedValue(new Error("network down"));
    const client = createMockClient(insert);

    const result = await ensureCandidateProfile(client, "user-1");

    expect(result.kind).toBe("error");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("settles without an unhandled rejection when a concurrent duplicate insert throws (StrictMode-like double invocation)", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    const insert = vi
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockRejectedValueOnce(new Error("network down"));
    const client = createMockClient(insert);

    const [first, second] = await Promise.allSettled([
      ensureCandidateProfile(client, "user-1"),
      ensureCandidateProfile(client, "user-1"),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("fulfilled");
    if (first.status === "fulfilled") expect(first.value).toEqual({ kind: "ready" });
    if (second.status === "fulfilled") expect(second.value.kind).toBe("error");

    // Give the event loop a turn — an unhandled rejection would surface here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();

    process.off("unhandledRejection", unhandled);
  });

  it("never calls update or upsert — insert only", async () => {
    const update = vi.fn();
    const upsert = vi.fn();
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({ insert, update, upsert }));
    const client = { from } as unknown as Pick<SupabaseClient, "from">;

    await ensureCandidateProfile(client, "user-1");

    expect(update).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("resolves both calls safely when a concurrent duplicate insert races (StrictMode-like double invocation)", async () => {
    const insert = vi
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({
        error: { code: "23505", message: "duplicate key value violates unique constraint" },
      });
    const client = createMockClient(insert);

    const [first, second] = await Promise.all([
      ensureCandidateProfile(client, "user-1"),
      ensureCandidateProfile(client, "user-1"),
    ]);

    expect(first).toEqual({ kind: "ready" });
    expect(second).toEqual({ kind: "ready" });
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("never logs database internals, tokens, or session data", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const insert = vi.fn().mockResolvedValue({
      error: { code: "42501", message: "permission denied for table candidate_profiles" },
    });
    const client = createMockClient(insert);

    await ensureCandidateProfile(client, "user-1");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("makes no real network call — the client is fully mocked", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const client = createMockClient(insert);

    await ensureCandidateProfile(client, "user-1");

    // The only way this test could reach a real network is if `insert`
    // were not the mock above — asserting call count proves the mock,
    // not a real fetch, handled the call.
    expect(insert).toHaveBeenCalledOnce();
  });
});
