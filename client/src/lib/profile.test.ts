import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { ensureCandidateProfile } from "./profile";

function createMockClient(upsertImpl: ReturnType<typeof vi.fn>) {
  const from = vi.fn(() => ({ upsert: upsertImpl }));
  return { from } as unknown as Pick<SupabaseClient, "from">;
}

describe("ensureCandidateProfile", () => {
  it("creates the row with ON CONFLICT DO NOTHING rather than a plain insert", async () => {
    // THE DEFECT THIS REPLACES. A plain INSERT makes every sign-in after the first a
    // guaranteed HTTP 409, which the BROWSER logs as a console error even though the code
    // treats it as success — and it is a wasted round trip every time. ignoreDuplicates
    // compiles to ON CONFLICT DO NOTHING: still create-only, no UPDATE, so the reason this is
    // not a mutating upsert still holds.
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const client = createMockClient(upsert);

    const result = await ensureCandidateProfile(client, "user-1");

    expect(result).toEqual({ kind: "ready" });
    expect(upsert).toHaveBeenCalledWith({ id: "user-1" }, { onConflict: "id", ignoreDuplicates: true });
  });

  it("returns ready on a successful create", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });

    expect(await ensureCandidateProfile(createMockClient(upsert), "user-1")).toEqual({ kind: "ready" });
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("still treats a 23505 unique-violation as already-ready", async () => {
    // KEPT AS A FALLBACK, not as the mechanism. If anything strips the Prefer header the
    // request degrades to a plain INSERT, and a conflict there must still be a success rather
    // than a failed sign-in.
    const upsert = vi.fn().mockResolvedValue({
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });

    expect(await ensureCandidateProfile(createMockClient(upsert), "user-1")).toEqual({ kind: "ready" });
  });

  it("returns a safe generic failure for any other error, never the raw message", async () => {
    const upsert = vi.fn().mockResolvedValue({
      error: { code: "42501", message: "permission denied for table candidate_profiles" },
    });

    const result = await ensureCandidateProfile(createMockClient(upsert), "user-1");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("permission denied");
      expect(result.message).not.toContain("candidate_profiles");
      expect(result.message).not.toContain("42501");
    }
  });

  it("returns the same generic failure for a thrown/rejected network error as for a resolved non-23505 error", async () => {
    const resolvedError = vi.fn().mockResolvedValue({
      error: { code: "42501", message: "permission denied for table candidate_profiles" },
    });
    const rejected = vi.fn().mockRejectedValue(new Error("network down"));

    const resolvedResult = await ensureCandidateProfile(createMockClient(resolvedError), "user-1");
    const rejectedResult = await ensureCandidateProfile(createMockClient(rejected), "user-1");

    expect(resolvedResult.kind).toBe("error");
    expect(rejectedResult.kind).toBe("error");
    if (resolvedResult.kind === "error" && rejectedResult.kind === "error") {
      // Same shared constant, not two independently-worded messages.
      expect(rejectedResult.message).toBe(resolvedResult.message);
    }
  });

  it("does not expose the thrown error's message, stack, or identity when the call rejects", async () => {
    const thrown = new Error("ECONNRESET: socket hang up at 10.0.0.5:5432");
    const upsert = vi.fn().mockRejectedValue(thrown);

    const result = await ensureCandidateProfile(createMockClient(upsert), "user-1");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("ECONNRESET");
      expect(result.message).not.toContain("10.0.0.5");
      expect(result.message).not.toContain(thrown.message);
    }
  });

  it("never logs a rejected call's error object, message, or stack", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const upsert = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await ensureCandidateProfile(createMockClient(upsert), "user-1");

    expect(result.kind).toBe("error");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("settles without an unhandled rejection when a concurrent duplicate call throws (StrictMode-like double invocation)", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    const upsert = vi.fn().mockResolvedValueOnce({ error: null }).mockRejectedValueOnce(new Error("network down"));

    const [first, second] = await Promise.allSettled([
      ensureCandidateProfile(createMockClient(upsert), "user-1"),
      ensureCandidateProfile(createMockClient(upsert), "user-1"),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("fulfilled");
    if (first.status === "fulfilled") expect(first.value).toEqual({ kind: "ready" });
    if (second.status === "fulfilled") expect(second.value.kind).toBe("error");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();

    process.off("unhandledRejection", unhandled);
  });

  it("never UPDATEs the row, and never falls back to a plain insert", async () => {
    const update = vi.fn();
    const insert = vi.fn();
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({ upsert, update, insert }));
    const client = { from } as unknown as Pick<SupabaseClient, "from">;

    await ensureCandidateProfile(client, "user-1");

    expect(upsert).toHaveBeenCalledOnce();
    // The table has no mutable field, so an UPDATE would be meaningless as well as wrong.
    expect(update).not.toHaveBeenCalled();
    // A plain insert is exactly the 409 this test exists to prevent.
    expect(insert).not.toHaveBeenCalled();
  });

  it("resolves both calls safely when a concurrent create races (StrictMode-like double invocation)", async () => {
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({
        error: { code: "23505", message: "duplicate key value violates unique constraint" },
      });
    const client = createMockClient(upsert);

    const [first, second] = await Promise.all([
      ensureCandidateProfile(client, "user-1"),
      ensureCandidateProfile(client, "user-1"),
    ]);

    expect(first).toEqual({ kind: "ready" });
    expect(second).toEqual({ kind: "ready" });
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("never logs database internals, tokens, or session data", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const upsert = vi.fn().mockResolvedValue({
      error: { code: "42501", message: "permission denied for table candidate_profiles" },
    });

    await ensureCandidateProfile(createMockClient(upsert), "user-1");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("makes no real network call - the client is fully mocked", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });

    await ensureCandidateProfile(createMockClient(upsert), "user-1");

    expect(upsert).toHaveBeenCalledOnce();
  });
});
