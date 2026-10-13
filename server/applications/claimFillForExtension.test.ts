import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { claimFillForExtension } from "./claimFillForExtension.js";
import type { EligibilityGates, EligibilityGateOutcome, GateResult } from "./eligibilityGate.js";

const pass: GateResult = { status: "pass" };
function gates(over: Record<string, GateResult> = {}): EligibilityGates {
  return {
    source_policy: pass, vacancy_trust: pass, automation_authorization: pass,
    candidate_exclusions: pass, idempotency: pass, role_match: pass, verified_facts: pass,
    application_support: pass, rate_and_abuse_controls: pass, dismissed: pass,
    preferred_qualifiers: pass, ...over,
  };
}

/**
 * Records the order of reads and the lease write, because the ordering is the property:
 * the gates must run before a lease is minted, or a refusal leaves the attempt claimed.
 */
function makeClient(opts: {
  attempts?: Array<Record<string, unknown>>;
  plan?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
  leaseMatches?: boolean;
  facts?: Array<{ id: string; fact_type: string; fact_value: string }>;
}) {
  const calls: string[] = [];
  const leaseWrites: Array<Record<string, unknown>> = [];
  const attempts = opts.attempts ?? [];

  const client = {
    from(table: string) {
      const rows = table === "application_attempts" ? attempts
        : table === "application_plans" ? (opts.plan ? [opts.plan] : [])
        : table === "candidate_profiles" ? (opts.profile ? [opts.profile] : [])
        : table === "extracted_facts" ? (opts.facts ?? [])
        : [];
      return {
        select: () => {
          calls.push("read:" + table);
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.in = () => chain;
          chain.order = () => chain;
          chain.limit = () => chain;
          chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
          chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
          return chain;
        },
        update: (payload: Record<string, unknown>) => {
          calls.push("write:application_attempts");
          leaseWrites.push(payload);
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.in = () => chain;
          chain.or = () => chain;
          chain.select = () => chain;
          chain.maybeSingle = async () => ({
            data: (opts.leaseMatches ?? true) ? { id: "attempt-1" } : null,
            error: null,
          });
          return chain;
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls, leaseWrites };
}

const ATTEMPT = {
  id: "attempt-1", application_plan_id: "plan-1", status: "pending",
  lease_token: null, leased_until: null, updated_at: "2026-10-01T00:00:00Z",
};
const PLAN = { id: "plan-1", vacancy_id: "vacancy-1", candidate_id: "candidate-1" };
const PROFILE = { review_before_submit: false };
const FACTS = [{ id: "f1", fact_type: "full_name", fact_value: "Priya Raman" }];
const CONFIRM = [{ extracted_fact_id: "f1", corrected_value: null }];

function gateSpy(outcome?: Partial<EligibilityGateOutcome>) {
  const calls: Array<{ candidateId: string; vacancyId: string }> = [];
  const fn = async (_c: SupabaseClient, ids: { candidateId: string; vacancyId: string }): Promise<EligibilityGateOutcome> => {
    calls.push(ids);
    return { eligible: true, gates: gates(), ...outcome };
  };
  return { fn, calls };
}

describe("claimFillForExtension", () => {
  it("mints a lease and returns the fill payload with the credentials Trip 2 needs", async () => {
    const { client, leaseWrites } = makeClient({ attempts: [ATTEMPT], plan: PLAN, profile: PROFILE, facts: FACTS });
    const spy = gateSpy();

    const result = await claimFillForExtension(client, { candidateId: "candidate-1", attemptId: "attempt-1" }, spy.fn);

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.attemptId).toBe("attempt-1");
    // THE LEASE TOKEN IS THE WHOLE POINT: without it Trip 2 cannot authorize anything.
    expect(typeof result.leaseToken).toBe("string");
    expect(result.leaseToken.length).toBeGreaterThan(0);
    expect(result.fill).toMatchObject({ candidateId: "candidate-1", vacancyId: "vacancy-1" });
    expect(leaseWrites[0]).toMatchObject({ status: "leased" });
    expect(typeof leaseWrites[0].leased_until).toBe("string");
  });

  it("RUNS THE GATES BEFORE MINTING A LEASE - a refusal must cost nothing", async () => {
    const { client, calls, leaseWrites } = makeClient({ attempts: [ATTEMPT], plan: PLAN, profile: PROFILE, facts: FACTS });
    const spy = gateSpy();

    await claimFillForExtension(client, { candidateId: "candidate-1", attemptId: "attempt-1" }, spy.fn);

    expect(calls.indexOf("write:application_attempts")).toBeGreaterThan(calls.indexOf("read:application_plans"));
    expect(leaseWrites).toHaveLength(1);
  });

  it("REFUSES and writes NOTHING when a gate fails, naming the gate", async () => {
    const { client, leaseWrites } = makeClient({ attempts: [ATTEMPT], plan: PLAN, profile: PROFILE, facts: FACTS });
    const failing = async (): Promise<EligibilityGateOutcome> => ({
      eligible: false,
      gates: gates({ plan_entitlement: { status: "fail", reasonCode: "QUOTA_EXHAUSTED" } }),
    });

    const result = await claimFillForExtension(client, { candidateId: "candidate-1", attemptId: "attempt-1" }, failing);

    expect(result).toMatchObject({ allowed: false, refusal: "GATE_FAILED", gate: "plan_entitlement" });
    expect(leaseWrites).toHaveLength(0);
  });

  it("REFUSES an attempt belonging to another candidate, without reaching the gates", async () => {
    const { client, leaseWrites } = makeClient({ attempts: [ATTEMPT], plan: { ...PLAN, candidate_id: "someone-else" }, profile: PROFILE });
    const spy = gateSpy();

    const result = await claimFillForExtension(client, { candidateId: "candidate-1", attemptId: "attempt-1" }, spy.fn);

    expect(result).toMatchObject({ allowed: false, refusal: "NOT_FOUND" });
    expect(spy.calls).toHaveLength(0);
    expect(leaseWrites).toHaveLength(0);
  });

  it("REFUSES an attempt already leased by someone else", async () => {
    const { client, leaseWrites } = makeClient({
      attempts: [{ ...ATTEMPT, status: "leased" }], plan: PLAN, profile: PROFILE,
    });
    const spy = gateSpy();

    const result = await claimFillForExtension(client, { candidateId: "candidate-1", attemptId: "attempt-1" }, spy.fn);

    expect(result).toMatchObject({ allowed: false, refusal: "ALREADY_CLAIMED" });
    expect(leaseWrites).toHaveLength(0);
  });

  it("REFUSES an attempt with nothing left to do", async () => {
    for (const status of ["succeeded", "submitting", "cancelled"]) {
      const { client, leaseWrites } = makeClient({ attempts: [{ ...ATTEMPT, status }], plan: PLAN, profile: PROFILE });
      const spy = gateSpy();
      const result = await claimFillForExtension(client, { candidateId: "candidate-1", attemptId: "attempt-1" }, spy.fn);
      expect(result.allowed, status).toBe(false);
      expect(leaseWrites, status).toHaveLength(0);
    }
  });

  it("REFUSES when it loses the lease race - zero rows updated is the answer", async () => {
    const { client } = makeClient({ attempts: [ATTEMPT], plan: PLAN, profile: PROFILE, facts: FACTS, leaseMatches: false });
    const spy = gateSpy();

    const result = await claimFillForExtension(client, { candidateId: "candidate-1", attemptId: "attempt-1" }, spy.fn);

    expect(result).toMatchObject({ allowed: false, refusal: "ALREADY_CLAIMED" });
  });

  it("allows a fill for an attempt HELD FOR REVIEW - filling is what review needs", async () => {
    const { client } = makeClient({
      attempts: [{ ...ATTEMPT, status: "pending_review" }], plan: PLAN,
      profile: { review_before_submit: true }, facts: FACTS,
    });
    const spy = gateSpy();

    const result = await claimFillForExtension(client, { candidateId: "candidate-1", attemptId: "attempt-1" }, spy.fn);
    expect(result.allowed).toBe(true);
  });
});
