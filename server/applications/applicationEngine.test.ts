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
    update: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    single: vi.fn(async () => result),
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as Record<string, unknown> & PromiseLike<TableResult>;
  return builder;
}

/**
 * Shapes for reaching into the from() mock's returned builders, so a test can
 * assert on a write payload without an inline type three braces deep.
 */
interface MockBuilderLike {
  update?: { mock: { calls: unknown[][] } };
  insert?: { mock: { calls: unknown[][] } };
}

interface MockFromLike {
  mock: { results: Array<{ value: MockBuilderLike }> };
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
    dismissed: { status: "pass" },
    preferred_qualifiers: { status: "pass", detail: { qualifiers: [], label: null } },
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
    dismissed: { status: "pass" },
    preferred_qualifiers: { status: "pass", detail: { qualifiers: [], label: null } },
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

  it("RE-EVALUATES an ineligible plan and enqueues an attempt once the gates pass", async () => {
    // The frozen-plan trap this patch exists to close. Previously a plan
    // marked ineligible — e.g. when no submission adapter was registered —
    // kept that verdict forever, so the pair could never be queued even after
    // an adapter shipped. The gates now run again, the plan transitions, and
    // the pending attempt is created on the same call.
    vi.mocked(evaluateEligibilityGates).mockResolvedValueOnce(eligibleOutcome);
    const client = makeClient({
      application_plans: [
        // Stored verdict: blocked by the missing adapter.
        { data: { id: "plan-frozen", gate_results: ineligibleOutcome }, error: null },
        // Fresh verdict, written back over it.
        { data: { id: "plan-frozen", gate_results: eligibleOutcome }, error: null },
      ],
      application_attempts: [
        { data: [], error: null },
        { data: { id: "attempt-1" }, error: null },
      ],
    });

    const result = await planApplication(client, input);

    expect(evaluateEligibilityGates).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      applicationPlanId: "plan-frozen",
      eligible: true,
      gateResults: eligibleOutcome,
      applicationAttemptId: "attempt-1",
      attemptCreated: true,
    });
  });

  it("writes the fresh verdict back over the frozen gate_results", async () => {
    vi.mocked(evaluateEligibilityGates).mockResolvedValueOnce(eligibleOutcome);
    const client = makeClient({
      application_plans: [
        { data: { id: "plan-frozen", gate_results: ineligibleOutcome }, error: null },
        { data: { id: "plan-frozen", gate_results: eligibleOutcome }, error: null },
      ],
      application_attempts: [
        { data: [], error: null },
        { data: { id: "attempt-1" }, error: null },
      ],
    });

    await planApplication(client, input);

    const fromMock = client.from as unknown as MockFromLike;
    const updateCall = fromMock.mock.results
      .map((entry) => entry.value.update)
      .find((update) => (update?.mock.calls.length ?? 0) > 0);

    expect(updateCall?.mock.calls[0][0]).toEqual({ gate_results: eligibleOutcome });
  });

  it("still reuses an ELIGIBLE plan untouched, without re-running the gates", async () => {
    // The asymmetry is deliberate: an eligible verdict has already been acted
    // on (an attempt may exist), so re-deriving it would spend queries to
    // re-decide something this function has no business changing.
    const client = makeClient({
      application_plans: [{ data: { id: "plan-3", gate_results: eligibleOutcome }, error: null }],
      application_attempts: [{ data: [{ id: "attempt-existing", status: "pending" }], error: null }],
    });

    const result = await planApplication(client, input);

    expect(evaluateEligibilityGates).not.toHaveBeenCalled();
    expect(result).toEqual({
      applicationPlanId: "plan-3",
      eligible: true,
      gateResults: eligibleOutcome,
      applicationAttemptId: "attempt-existing",
      attemptCreated: false,
    });
  });

  describe("Task U: the review-before-submit gate decides the attempt's initial status", () => {
    /** The payload of the application_attempts insert, or undefined if none happened. */
    function attemptInsertPayload(client: unknown): unknown {
      // Matched on the TABLE, not just "the first insert that happened":
      // planApplication also inserts an application_plans row, and picking that
      // one up would assert against the wrong payload.
      const fromMock = (client as { from: unknown }).from as {
        mock: {
          calls: unknown[][];
          results: Array<{ value: MockBuilderLike }>;
        };
      };

      const index = fromMock.mock.calls.findIndex(
        (call, position) =>
          call[0] === "application_attempts" &&
          (fromMock.mock.results[position]?.value.insert?.mock.calls.length ?? 0) > 0,
      );

      return index === -1 ? undefined : fromMock.mock.results[index].value.insert?.mock.calls[0][0];
    }

    it("holds the attempt as pending_review when the candidate requires review", async () => {
      vi.mocked(evaluateEligibilityGates).mockResolvedValueOnce(eligibleOutcome);
      const client = makeClient({
        candidate_profiles: [{ data: { review_before_submit: true }, error: null }],
        application_plans: [
          { data: null, error: null },
          { data: { id: "plan-review", gate_results: eligibleOutcome }, error: null },
        ],
        application_attempts: [
          { data: [], error: null },
          { data: { id: "attempt-1" }, error: null },
        ],
      });

      await planApplication(client, input);

      expect(attemptInsertPayload(client)).toEqual({
        application_plan_id: "plan-review",
        status: "pending_review",
      });
    });

    it("creates a claimable attempt when the candidate has turned review off", async () => {
      vi.mocked(evaluateEligibilityGates).mockResolvedValueOnce(eligibleOutcome);
      const client = makeClient({
        candidate_profiles: [{ data: { review_before_submit: false }, error: null }],
        application_plans: [
          { data: null, error: null },
          { data: { id: "plan-auto", gate_results: eligibleOutcome }, error: null },
        ],
        application_attempts: [
          { data: [], error: null },
          { data: { id: "attempt-1" }, error: null },
        ],
      });

      await planApplication(client, input);

      expect(attemptInsertPayload(client)).toEqual({
        application_plan_id: "plan-auto",
        status: "pending",
      });
    });

    it("fails safe to holding when the preference cannot be read", async () => {
      // An unreadable preference must never be the reason an application is
      // dispatched without the candidate having seen it — the column default is
      // true, and so is the fallback for a missing row.
      vi.mocked(evaluateEligibilityGates).mockResolvedValueOnce(eligibleOutcome);
      const client = makeClient({
        candidate_profiles: [{ data: null, error: null }],
        application_plans: [
          { data: null, error: null },
          { data: { id: "plan-missing", gate_results: eligibleOutcome }, error: null },
        ],
        application_attempts: [
          { data: [], error: null },
          { data: { id: "attempt-1" }, error: null },
        ],
      });

      await planApplication(client, input);

      expect(attemptInsertPayload(client)).toMatchObject({ status: "pending_review" });
    });

    it("does not create a second attempt beside one already sitting in the review queue", async () => {
      // The gate would be pointless if planning could route around it by
      // opening a claimable attempt next to the held one.
      const client = makeClient({
        application_plans: [{ data: { id: "plan-held", gate_results: eligibleOutcome }, error: null }],
        application_attempts: [{ data: [{ id: "attempt-held", status: "pending_review" }], error: null }],
      });

      const result = await planApplication(client, input);

      expect(result).toMatchObject({
        applicationAttemptId: "attempt-held",
        attemptCreated: false,
      });
      expect(attemptInsertPayload(client)).toBeUndefined();
    });
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
