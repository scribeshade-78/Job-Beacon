import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { authorizeSubmission } from "./autoApplyClaim.js";
import type { EligibilityGates, EligibilityGateOutcome, GateResult } from "./eligibilityGate.js";

const pass: GateResult = { status: "pass" };

function gates(overrides: Record<string, GateResult> = {}): EligibilityGates {
  return {
    source_policy: pass, vacancy_trust: pass, automation_authorization: pass,
    idempotency: pass, role_match: pass, verified_facts: pass,
    application_support: pass, rate_and_abuse_controls: pass, dismissed: pass,
    preferred_qualifiers: pass, ...overrides,
  };
}

/**
 * A fake that RECORDS THE ORDER of reads and writes, because the ordering is the
 * security property: gates must run before anything is consumed.
 */
function makeClient(opts: {
  attempt?: Record<string, unknown> | null;
  plan?: Record<string, unknown> | null;
  consumed?: boolean;
  profile?: Record<string, unknown> | null;
}) {
  const calls: string[] = [];
  const updates: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
      return {
        select: () => {
          calls.push("read:" + table);
          const row = table === "application_attempts" ? (opts.attempt ?? null)
            : table === "application_plans" ? (opts.plan ?? null)
            : (opts.profile ?? null);
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.maybeSingle = async () => ({ data: row, error: null });
          return chain;
        },
        update: (payload: Record<string, unknown>) => {
          calls.push("write:application_attempts");
          updates.push(payload);
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.in = () => chain;
          chain.select = () => chain;
          chain.maybeSingle = async () => ({ data: (opts.consumed ?? true) ? { id: "attempt-1" } : null, error: null });
          return chain;
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls, updates };
}

const ATTEMPT = { id: "attempt-1", application_plan_id: "plan-1", status: "pending", lease_token: "lease-1", review_approved_at: "2026-10-01T00:00:00Z" };
const PLAN = { id: "plan-1", vacancy_id: "vacancy-1", candidate_id: "candidate-1" };
const PROFILE = { review_before_submit: true };

function gateSpy() {
  const calls: Array<{ candidateId: string; vacancyId: string }> = [];
  const fn = async (_c: SupabaseClient, ids: { candidateId: string; vacancyId: string }): Promise<EligibilityGateOutcome> => {
    calls.push(ids);
    return { eligible: true, gates: gates() };
  };
  return { fn, calls };
}

describe("authorizeSubmission", () => {
  it("authorises and consumes once, for the owning candidate", async () => {
    const { client, calls, updates } = makeClient({ attempt: ATTEMPT, plan: PLAN, profile: PROFILE });
    const spy = gateSpy();

    const result = await authorizeSubmission(client, { candidateId: "candidate-1", attemptId: "attempt-1", leaseToken: "lease-1" }, spy.fn);

    expect(result).toEqual({ allowed: true, attemptId: "attempt-1", vacancyId: "vacancy-1" });
    expect(spy.calls).toEqual([{ candidateId: "candidate-1", vacancyId: "vacancy-1" }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "submitting" });
  });

  it("RUNS THE GATES BEFORE ANY WRITE - a refusal must cost nothing", async () => {
    const { client, calls } = makeClient({ attempt: ATTEMPT, plan: PLAN, profile: PROFILE });
    const spy = gateSpy();

    await authorizeSubmission(client, { candidateId: "candidate-1", attemptId: "attempt-1", leaseToken: "lease-1" }, spy.fn);

    const readPlan = calls.indexOf("read:application_plans");
    const write = calls.indexOf("write:application_attempts");
    expect(readPlan).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(readPlan);
  });

  it("REFUSES and writes NOTHING when a gate fails, naming the gate", async () => {
    const { client, updates } = makeClient({ attempt: ATTEMPT, plan: PLAN, profile: PROFILE });
    const failing = async (): Promise<EligibilityGateOutcome> => ({
      eligible: false,
      gates: gates({ plan_entitlement: { status: "fail", reasonCode: "QUOTA_EXHAUSTED" } }),
    });

    const result = await authorizeSubmission(client, { candidateId: "candidate-1", attemptId: "attempt-1", leaseToken: "lease-1" }, failing);

    expect(result).toEqual({ allowed: false, refusal: "GATE_FAILED", gate: "plan_entitlement", reasonCode: "QUOTA_EXHAUSTED" });
    expect(updates).toHaveLength(0);
  });

  it("REFUSES an attempt belonging to someone else, and never reaches the gates", async () => {
    // Guessing a uuid must not let one candidate submit another candidate application. The
    // refusal is identical to a missing attempt so it cannot be used to probe.
    const { client, updates } = makeClient({ attempt: ATTEMPT, plan: { ...PLAN, candidate_id: "someone-else" }, profile: PROFILE });
    const spy = gateSpy();

    const result = await authorizeSubmission(client, { candidateId: "candidate-1", attemptId: "attempt-1", leaseToken: "lease-1" }, spy.fn);

    expect(result).toEqual({ allowed: false, refusal: "NOT_FOUND" });
    expect(spy.calls).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("REFUSES a wrong lease token - a caller cannot submit what it does not hold", async () => {
    const { client, updates } = makeClient({ attempt: ATTEMPT, plan: PLAN, profile: PROFILE });
    const spy = gateSpy();

    const result = await authorizeSubmission(client, { candidateId: "candidate-1", attemptId: "attempt-1", leaseToken: "not-the-lease" }, spy.fn);

    expect(result).toEqual({ allowed: false, refusal: "LEASE_LOST" });
    expect(updates).toHaveLength(0);
  });

  it("REFUSES when review is required and the row shows NO approval", async () => {
    // Approval comes from review_approved_at on the row, never from the request, so a
    // client cannot assert that a human approved it.
    const { client, updates } = makeClient({ attempt: { ...ATTEMPT, review_approved_at: null }, plan: PLAN, profile: PROFILE });
    const spy = gateSpy();

    const result = await authorizeSubmission(client, { candidateId: "candidate-1", attemptId: "attempt-1", leaseToken: "lease-1" }, spy.fn);

    expect(result).toEqual({ allowed: false, refusal: "NOT_APPROVED" });
    expect(updates).toHaveLength(0);
  });

  it("REFUSES the SECOND call - the consumption is single-use", async () => {
    // The first call consumed the attempt by moving the status; this one matches no rows.
    const { client } = makeClient({ attempt: ATTEMPT, plan: PLAN, profile: PROFILE, consumed: false });
    const spy = gateSpy();

    const result = await authorizeSubmission(client, { candidateId: "candidate-1", attemptId: "attempt-1", leaseToken: "lease-1" }, spy.fn);

    expect(result).toEqual({ allowed: false, refusal: "ALREADY_CONSUMED" });
  });

  it("REFUSES an attempt that is already submitting or succeeded", async () => {
    for (const status of ["submitting", "succeeded", "cancelled", "leased"]) {
      const { client, updates } = makeClient({ attempt: { ...ATTEMPT, status }, plan: PLAN, profile: PROFILE });
      const spy = gateSpy();
      const result = await authorizeSubmission(client, { candidateId: "candidate-1", attemptId: "attempt-1", leaseToken: "lease-1" }, spy.fn);
      expect(result.allowed, status).toBe(false);
      expect(updates, status).toHaveLength(0);
    }
  });
});
