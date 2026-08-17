import { describe, expect, it, vi } from "vitest";
import { submitModerationDecision, ReviewerSeparationError } from "./decisions.js";

function makeClient(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain = (method: string) => (...args: unknown[]) => (calls.push({ method, args }), builder);
  const builder = {
    calls,
    insert: chain("insert"),
    select: chain("select"),
    single: (...args: unknown[]) => (calls.push({ method: "single", args }), result),
  };
  const from = vi.fn(() => builder);
  const client = { from } as unknown as Parameters<typeof submitModerationDecision>[0];

  return { client, from, calls };
}

const baseInput = {
  caseId: "case-1",
  reviewerId: "reviewer-1",
  decision: "blocked" as const,
  rationale: "Confirmed scam pattern.",
  policyVersion: "r3-moderation-v1",
};

describe("submitModerationDecision", () => {
  it("inserts a decision with the given reviewerId and returns its id", async () => {
    const { client, from, calls } = makeClient({ data: { id: "decision-1" }, error: null });

    const result = await submitModerationDecision(client, baseInput);

    expect(result).toEqual({ id: "decision-1" });
    expect(from).toHaveBeenCalledWith("moderation_decisions");
    expect(calls[0]).toEqual({
      method: "insert",
      args: [
        {
          moderation_case_id: "case-1",
          reviewer_id: "reviewer-1",
          decision: "blocked",
          rationale: "Confirmed scam pattern.",
          policy_version: "r3-moderation-v1",
          appeal_id: null,
        },
      ],
    });
  });

  it("passes appealId through when resolving an appeal", async () => {
    const { client, calls } = makeClient({ data: { id: "decision-2" }, error: null });

    await submitModerationDecision(client, { ...baseInput, appealId: "appeal-1" });

    expect((calls[0].args[0] as { appeal_id: unknown }).appeal_id).toBe("appeal-1");
  });

  it("throws a ReviewerSeparationError when the DB trigger rejects with P0001", async () => {
    const { client } = makeClient({ data: null, error: { message: "Reviewer separation violation", code: "P0001" } });

    await expect(submitModerationDecision(client, baseInput)).rejects.toBeInstanceOf(ReviewerSeparationError);
  });

  it("rethrows other database errors as-is", async () => {
    const { client } = makeClient({ data: null, error: { message: "some other db error", code: "23503" } });

    await expect(submitModerationDecision(client, baseInput)).rejects.not.toBeInstanceOf(ReviewerSeparationError);
  });
});
