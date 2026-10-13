import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { isConfirmingEvidence, reportAutoApplyOutcome } from "./reportAutoApplyOutcome.js";
import { ACCEPTANCE_EVIDENCE_TYPE } from "../../shared/pipelineStages.js";

/** A fake that RECORDS every insert and update, so the contract can be asserted exactly. */
function makeClient(opts: {
  attempt?: Record<string, unknown> | null;
  plan?: Record<string, unknown> | null;
  evidenceFails?: boolean;
  updateMatches?: boolean;
}) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
      return {
        select: () => {
          const row = table === "application_attempts" ? (opts.attempt ?? null) : (opts.plan ?? null);
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.maybeSingle = async () => ({ data: row, error: null });
          return chain;
        },
        insert: async (payload: Record<string, unknown>) => {
          inserts.push(payload);
          return { error: opts.evidenceFails ? { message: "insert failed" } : null };
        },
        update: (payload: Record<string, unknown>) => {
          updates.push(payload);
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.select = () => chain;
          chain.maybeSingle = async () => ({
            data: (opts.updateMatches ?? true) ? { id: "attempt-1" } : null,
            error: null,
          });
          return chain;
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, inserts, updates };
}

const ATTEMPT = { id: "attempt-1", application_plan_id: "plan-1", status: "submitting", lease_token: "lease-1" };
const PLAN = { id: "plan-1", candidate_id: "candidate-1" };
const input = (over: Record<string, unknown> = {}) => ({
  candidateId: "candidate-1", attemptId: "attempt-1", leaseToken: "lease-1",
  outcome: "succeeded" as const, ...over,
});
const CONFIRMING = { confirmationUrl: "https://boards.greenhouse.io/x/confirmation", confirmationText: "Application Submitted" };

describe("isConfirmingEvidence", () => {
  it("rejects null, undefined and EMPTY STRINGS - three blanks are not a confirmation", () => {
    expect(isConfirmingEvidence(null)).toBe(false);
    expect(isConfirmingEvidence(undefined)).toBe(false);
    expect(isConfirmingEvidence({})).toBe(false);
    expect(isConfirmingEvidence({ confirmationUrl: "", confirmationText: "   ", referenceId: "" })).toBe(false);
  });
  it("accepts any single non-blank field", () => {
    expect(isConfirmingEvidence({ confirmationUrl: "https://x" })).toBe(true);
    expect(isConfirmingEvidence({ confirmationText: "Submitted" })).toBe(true);
    expect(isConfirmingEvidence({ referenceId: "A1B2" })).toBe(true);
  });
});

describe("reportAutoApplyOutcome - refusals", () => {
  it("refuses an attempt belonging to another candidate, identically to a missing one", async () => {
    const { client, inserts, updates } = makeClient({ attempt: ATTEMPT, plan: { ...PLAN, candidate_id: "someone-else" } });
    const result = await reportAutoApplyOutcome(client, input({ evidence: CONFIRMING }));
    expect(result).toEqual({ accepted: false, refusal: "NOT_FOUND" });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("refuses a wrong lease token", async () => {
    const { client, updates } = makeClient({ attempt: ATTEMPT, plan: PLAN });
    const result = await reportAutoApplyOutcome(client, input({ leaseToken: "wrong", evidence: CONFIRMING }));
    expect(result).toEqual({ accepted: false, refusal: "LEASE_LOST" });
    expect(updates).toHaveLength(0);
  });

  it("refuses an attempt that is not mid-submission - only submitting may report", async () => {
    for (const status of ["pending", "pending_review", "succeeded", "failed", "cancelled"]) {
      const { client, inserts, updates } = makeClient({ attempt: { ...ATTEMPT, status }, plan: PLAN });
      const result = await reportAutoApplyOutcome(client, input({ evidence: CONFIRMING }));
      expect(result, status).toEqual({ accepted: false, refusal: "NOT_SUBMITTING" });
      expect(inserts, status).toHaveLength(0);
      expect(updates, status).toHaveLength(0);
    }
  });

  it("CATEGORICALLY refuses an outcome that is not exactly succeeded or failed", async () => {
    for (const bad of ["success", "SUCCEEDED", "ok", "", "cancelled", "action_required", "needs_verification"]) {
      const { client, inserts, updates } = makeClient({ attempt: ATTEMPT, plan: PLAN });
      const result = await reportAutoApplyOutcome(client, input({ outcome: bad, evidence: CONFIRMING }));
      expect(result, bad).toEqual({ accepted: false, refusal: "BAD_OUTCOME" });
      expect(inserts, bad).toHaveLength(0);
      expect(updates, bad).toHaveLength(0);
    }
  });
});

describe("reportAutoApplyOutcome - the CONFIRMED path is the only way to succeeded", () => {
  it("writes the canonical acceptance type, succeeds, stamps succeeded_at and clears the lease", async () => {
    const { client, inserts, updates } = makeClient({ attempt: ATTEMPT, plan: PLAN });
    const result = await reportAutoApplyOutcome(client, input({ evidence: CONFIRMING }));

    expect(result).toEqual({ accepted: true, finalStatus: "succeeded" });
    expect(inserts[0]).toMatchObject({ application_attempt_id: "attempt-1", evidence_type: ACCEPTANCE_EVIDENCE_TYPE });
    expect(updates[0]).toMatchObject({ status: "succeeded", lease_token: null, leased_until: null });
    expect(typeof updates[0].succeeded_at).toBe("string");
  });

  it("falls back to needs_verification when the RECEIPT cannot be written", async () => {
    const { client, updates } = makeClient({ attempt: ATTEMPT, plan: PLAN, evidenceFails: true });
    const result = await reportAutoApplyOutcome(client, input({ evidence: CONFIRMING }));
    expect(result).toEqual({ accepted: true, finalStatus: "needs_verification" });
    expect(updates).toHaveLength(0);
  });

  it("falls back to needs_verification when the status update loses its race", async () => {
    const { client } = makeClient({ attempt: ATTEMPT, plan: PLAN, updateMatches: false });
    const result = await reportAutoApplyOutcome(client, input({ evidence: CONFIRMING }));
    expect(result).toEqual({ accepted: true, finalStatus: "needs_verification" });
  });
});

describe("reportAutoApplyOutcome - the UNPROVEN path never claims success", () => {
  for (const [name, evidence] of [
    ["no evidence at all", null],
    ["an empty object", {}],
    ["only blank strings", { confirmationUrl: "", confirmationText: "  ", referenceId: "" }],
  ] as Array<[string, unknown]>) {
    it("leaves the attempt at submitting, with NO succeeded_at, for " + name, async () => {
      const { client, inserts, updates } = makeClient({ attempt: ATTEMPT, plan: PLAN });
      const result = await reportAutoApplyOutcome(client, input({ evidence }));

      expect(result).toEqual({ accepted: true, finalStatus: "needs_verification" });
      // THE HEART OF IT: the canonical acceptance type is NOT written, so no reader can
      // mistake this for a verified submission.
      expect(inserts[0].evidence_type).not.toBe(ACCEPTANCE_EVIDENCE_TYPE);
      expect(inserts[0]).toMatchObject({ evidence_type: "submission_unverified" });
      // AND THE STATUS IS NEVER TOUCHED, so succeeded_at cannot be stamped either.
      expect(updates[0]).not.toHaveProperty("status");
      expect(updates[0]).not.toHaveProperty("succeeded_at");
      // The lease IS released: the extension is done, whatever we concluded.
      expect(updates[0]).toMatchObject({ lease_token: null, leased_until: null });
    });
  }
});

describe("reportAutoApplyOutcome - failure", () => {
  it("writes submission_error with the reason, fails the attempt and clears the lease", async () => {
    const { client, inserts, updates } = makeClient({ attempt: ATTEMPT, plan: PLAN });
    const result = await reportAutoApplyOutcome(client, input({
      outcome: "failed",
      error: { message: "The page rejected the form", reasonCode: "VALIDATION", retryable: false },
    }));

    expect(result).toEqual({ accepted: true, finalStatus: "failed" });
    expect(inserts[0]).toMatchObject({ evidence_type: "submission_error" });
    expect(inserts[0].payload).toMatchObject({ message: "The page rejected the form", reasonCode: "VALIDATION", retryable: false });
    expect(updates[0]).toMatchObject({ status: "failed", last_error: "The page rejected the form", lease_token: null, leased_until: null });
  });

  it("uses a plain sentence when the extension gives no message, rather than an empty one", async () => {
    const { client, updates } = makeClient({ attempt: ATTEMPT, plan: PLAN });
    await reportAutoApplyOutcome(client, input({ outcome: "failed", error: null }));
    expect(updates[0].last_error).toBe("The submission did not complete.");
  });

  it("does NOT stamp succeeded_at on a failure", async () => {
    const { client, updates } = makeClient({ attempt: ATTEMPT, plan: PLAN });
    await reportAutoApplyOutcome(client, input({ outcome: "failed" }));
    expect(updates[0]).not.toHaveProperty("succeeded_at");
  });
});
