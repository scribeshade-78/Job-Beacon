import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APPLICATION_PREFERENCES,
  loadApplicationPreferences,
  updateResumeOptimizationLevel,
  updateReviewBeforeSubmit,
} from "./applicationPreferences";

type Client = Parameters<typeof loadApplicationPreferences>[0];

/** .from().select().eq().maybeSingle() */
function readClient(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as unknown as Client, from, select, eq, maybeSingle };
}

/** .from().update().eq().select() */
function writeClient(result: { data: unknown; error: unknown }) {
  const select = vi.fn().mockResolvedValue(result);
  const eq = vi.fn(() => ({ select }));
  const update = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ update }));
  return { client: { from } as unknown as Client, from, update, eq, select };
}

describe("loadApplicationPreferences", () => {
  it("returns the stored values for the candidate's own row", async () => {
    const { client, eq } = readClient({
      data: { resume_optimization_level: "aggressive", review_before_submit: false },
      error: null,
    });

    const result = await loadApplicationPreferences(client, "candidate-1");

    expect(eq).toHaveBeenCalledWith("id", "candidate-1");
    expect(result).toEqual({
      kind: "success",
      preferences: { resumeOptimizationLevel: "aggressive", reviewBeforeSubmit: false },
    });
  });

  it("falls back to the documented column defaults when the profile row does not exist yet", async () => {
    const { client } = readClient({ data: null, error: null });

    const result = await loadApplicationPreferences(client, "candidate-1");

    expect(result).toEqual({ kind: "success", preferences: DEFAULT_APPLICATION_PREFERENCES });
    // The defaults here must match the SQL column defaults, not merely look
    // plausible — review_before_submit defaulting the safe way is the whole
    // product decision in that migration.
    expect(DEFAULT_APPLICATION_PREFERENCES).toEqual({
      resumeOptimizationLevel: "honest",
      reviewBeforeSubmit: true,
    });
  });

  it("falls back per-field when a stored value is not one this bundle knows", async () => {
    const { client } = readClient({
      data: { resume_optimization_level: "maximum", review_before_submit: "yes" },
      error: null,
    });

    const result = await loadApplicationPreferences(client, "candidate-1");

    expect(result).toEqual({ kind: "success", preferences: DEFAULT_APPLICATION_PREFERENCES });
  });

  it("returns a generic error and never leaks the raw database message", async () => {
    const { client } = readClient({ data: null, error: { message: "permission denied for table" } });

    const result = await loadApplicationPreferences(client, "candidate-1");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("permission");
    }
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("boom");
    });

    const result = await loadApplicationPreferences({ from } as unknown as Client, "candidate-1");

    expect(result.kind).toBe("error");
  });
});

describe("updateResumeOptimizationLevel", () => {
  it("writes only the level column for the given candidate", async () => {
    const { client, update, eq } = writeClient({ data: [{ id: "candidate-1" }], error: null });

    const result = await updateResumeOptimizationLevel(client, "candidate-1", "aggressive");

    expect(result).toEqual({ kind: "success" });
    expect(update).toHaveBeenCalledWith({ resume_optimization_level: "aggressive" });
    expect(eq).toHaveBeenCalledWith("id", "candidate-1");
  });

  it("treats a zero-row update as a failure, not a silent success", async () => {
    // PostgREST reports "matched nothing" as 204 with no error. Without the
    // .select() round-trip check the UI would claim a preference was saved
    // when the database never changed — the exact promise this setting makes.
    const { client } = writeClient({ data: [], error: null });

    const result = await updateResumeOptimizationLevel(client, "candidate-1", "off");

    expect(result.kind).toBe("error");
  });

  it("returns a generic error on a Postgres error", async () => {
    const { client } = writeClient({ data: null, error: { message: 'new row violates check constraint "x"' } });

    const result = await updateResumeOptimizationLevel(client, "candidate-1", "off");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("check constraint");
    }
  });
});

describe("updateReviewBeforeSubmit", () => {
  it("writes the boolean for the given candidate", async () => {
    const { client, update } = writeClient({ data: [{ id: "candidate-1" }], error: null });

    const result = await updateReviewBeforeSubmit(client, "candidate-1", false);

    expect(result).toEqual({ kind: "success" });
    expect(update).toHaveBeenCalledWith({ review_before_submit: false });
  });

  it("treats a zero-row update as a failure", async () => {
    const { client } = writeClient({ data: [], error: null });

    const result = await updateReviewBeforeSubmit(client, "candidate-1", true);

    expect(result.kind).toBe("error");
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("boom");
    });

    const result = await updateReviewBeforeSubmit({ from } as unknown as Client, "candidate-1", true);

    expect(result.kind).toBe("error");
  });
});
