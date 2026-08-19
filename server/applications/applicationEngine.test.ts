import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./eligibilityGate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./eligibilityGate.js")>();
  return { ...actual, evaluateEligibilityGates: vi.fn() };
});

import { evaluateEligibilityGates, type EligibilityGateOutcome } from "./eligibilityGate.js";
import { planApplication } from "./applicationEngine.js";

type TableResult = { data: unknown; error: unknown };

function chain(result: TableResult) {
  const builder: Record<string, unknown> & PromiseLike<TableResult> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    single: vi.fn(async () => result),
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as Record<string, unknown> & PromiseLike<TableResult>;
  return builder;
}

/** Each table's array of results is consumed one per `.from(table)` call, in order. */
function makeClient(queues: Partial<Record<string, TableResult[]>> = {}) {
  const remaining: Record<string, TableResult[]> = {
    application_plans: [],
    application_attempts: [],
    ...queues,
  };
  const from = vi.fn((table: string) => {
    const queue = remaining[table];
    const result = queue && queue.length > 0 ? queue.shift()! : { data: null, error: null };
    return chain(result);
  });
  return { from } as unknown as Parameters<typeof planApplication>[0];
}

const input = { candidateId: "candidate-1", vacancyId: "vacancy-1" };

const ineligibleOutcome: EligibilityGateOutcome = {
  eligible: false,
  gates: {
    source_policy: { status: "fail", reasonCode: "SOURCE_APPLICATION_NOT_AUTHORIZED" },
    vacancy_trust: { status: "pass" },
    automation_authorization: { status: "pass" },
    candidate_exclusions: { status: "pass", detail: { excludedCategories: [] } },
    idempotency: { status: "pass" },
    role_match: { status: "fail", reasonCode: "NO_ROLES_SELECTED" },
    verified_facts: { status: "fail", reasonCode: "NO_FACTS_EXTRACTED" },
    application_support: { status: "fail", reasonCode: "APPLICATION_SUPPORT_NOT_IMPLEMENTED" },
    rate_and_abuse_controls: { status: "fail", reasonCode: "RATE_CONTROLS_NOT_IMPLEMENTED" },
  },
};

const eligibleOutcome: EligibilityGateOutcome = {
  eligible: true,
  gates: {
    source_policy: { status: "pass" },
    vacancy_trust: { status: "pass" },
    automation_authorization: { status: "pass" },
    candidate_exclusions: { status: "pass", detail: { excludedCategories: [] } },
    idempotency: { status: "pass" },
    role_match: { status: "pass" },
    verified_facts: { status: "pass" },
    application_support: { status: "pass" },
    rate_and_abuse_controls: { status: "pass" },
  },
};

describe("planApplication", () => {
  beforeEach(() => {
    vi.mocked(evaluateEligibilityGates).mockClear();
  });

  it("creates a new plan and does not create an attempt when the gates are ineligible", async () => {
    vi.mocked(evaluateEligibilityGates).mockResolvedValueOnce(ineligibleOutcome);
    const client = makeClient({
      application_plans: [
        { data: null, error: null },
        { data: { id: "plan-1", gate_results: ineligibleOutcome }, error: null },
      ],
    });

    const result = await planApplication(client, input);

    expect(result).toEqual({
      applicationPlanId: "plan-1",
      eligible: false,
      gateResults: ineligibleOutcome,
      attemptCreated: false,
    });
    // No application_attempts query at all for an ineligible plan.
    expect((client.from as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith("application_attempts");
  });

  it("creates a new plan and a pending attempt when the gates are eligible (mocked)", async () => {
    vi.mocked(evaluateEligibilityGates).mockResolvedValueOnce(eligibleOutcome);
    const client = makeClient({
      application_plans: [
        { data: null, error: null },
        { data: { id: "plan-2", gate_results: eligibleOutcome }, error: null },
      ],
      application_attempts: [
        { data: [], error: null },
        { data: { id: "attempt-1" }, error: null },
      ],
    });

    const result = await planApplication(client, input);

    expect(result).toEqual({
      applicationPlanId: "plan-2",
      eligible: true,
      gateResults: eligibleOutcome,
      applicationAttemptId: "attempt-1",
      attemptCreated: true,
    });
  });

  it("reuses an existing plan's frozen gate_results without re-evaluating the gates", async () => {
    const client = makeClient({
      application_plans: [{ data: { id: "plan-3", gate_results: ineligibleOutcome }, error: null }],
    });

    const result = await planApplication(client, input);

    expect(result).toEqual({
      applicationPlanId: "plan-3",
      eligible: false,
      gateResults: ineligibleOutcome,
      attemptCreated: false,
    });
    expect(evaluateEligibilityGates).not.toHaveBeenCalled();
  });

  it("idempotency: does not create a second attempt when an active attempt already exists on an eligible plan", async () => {
    const client = makeClient({
      application_plans: [{ data: { id: "plan-4", gate_results: eligibleOutcome }, error: null }],
      application_attempts: [{ data: [{ id: "attempt-existing", status: "pending" }], error: null }],
    });

    const result = await planApplication(client, input);

    expect(result).toEqual({
      applicationPlanId: "plan-4",
      eligible: true,
      gateResults: eligibleOutcome,
      applicationAttemptId: "attempt-existing",
      attemptCreated: false,
    });
  });

  it("idempotency: creates a new attempt when the plan's only prior attempt failed (safe to retry)", async () => {
    const client = makeClient({
      application_plans: [{ data: { id: "plan-5", gate_results: eligibleOutcome }, error: null }],
      application_attempts: [
        { data: [{ id: "attempt-old", status: "failed" }], error: null },
        { data: { id: "attempt-new" }, error: null },
      ],
    });

    const result = await planApplication(client, input);

    expect(result).toEqual({
      applicationPlanId: "plan-5",
      eligible: true,
      gateResults: eligibleOutcome,
      applicationAttemptId: "attempt-new",
      attemptCreated: true,
    });
  });

  it("idempotency: recovers from a concurrent duplicate-plan insert (23505) by re-reading the winning row instead of failing", async () => {
    vi.mocked(evaluateEligibilityGates).mockResolvedValueOnce(ineligibleOutcome);
    const client = makeClient({
      application_plans: [
        { data: null, error: null },
        { data: null, error: { code: "23505", message: "duplicate key" } },
        { data: { id: "plan-winner", gate_results: ineligibleOutcome }, error: null },
      ],
    });

    const result = await planApplication(client, input);

    expect(result).toEqual({
      applicationPlanId: "plan-winner",
      eligible: false,
      gateResults: ineligibleOutcome,
      attemptCreated: false,
    });
  });

  describe("error propagation", () => {
    it("propagates a database error from the initial plan lookup", async () => {
      const client = makeClient({
        application_plans: [{ data: null, error: { message: "db error" } }],
      });
      await expect(planApplication(client, input)).rejects.toBeTruthy();
    });

    it("propagates a non-23505 database error from the plan insert", async () => {
      vi.mocked(evaluateEligibilityGates).mockResolvedValueOnce(ineligibleOutcome);
      const client = makeClient({
        application_plans: [
          { data: null, error: null },
          { data: null, error: { code: "23503", message: "fk violation" } },
        ],
      });
      await expect(planApplication(client, input)).rejects.toBeTruthy();
    });

    it("propagates a database error from the attempts lookup", async () => {
      const client = makeClient({
        application_plans: [{ data: { id: "plan-6", gate_results: eligibleOutcome }, error: null }],
        application_attempts: [{ data: null, error: { message: "db error" } }],
      });
      await expect(planApplication(client, input)).rejects.toBeTruthy();
    });

    it("propagates a database error from the attempt insert", async () => {
      const client = makeClient({
        application_plans: [{ data: { id: "plan-7", gate_results: eligibleOutcome }, error: null }],
        application_attempts: [
          { data: [], error: null },
          { data: null, error: { message: "db error" } },
        ],
      });
      await expect(planApplication(client, input)).rejects.toBeTruthy();
    });
  });
});
