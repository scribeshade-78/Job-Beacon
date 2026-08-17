import { describe, expect, it, vi } from "vitest";
import { evaluateEligibilityGates } from "./eligibilityGate.js";

type TableResult = { data: unknown; error: unknown };

/**
 * A minimal fluent builder matching exactly the call shapes
 * eligibilityGate.ts uses (.select().eq()[.eq()][.maybeSingle()]).
 * .select()/.eq() are no-ops that return the same builder so any number
 * of chained calls works; the builder itself is thenable so code that
 * awaits without calling .maybeSingle() (the array-returning queries)
 * also resolves to `result`, mirroring real postgrest-js behavior.
 */
function makeQueryBuilder(result: TableResult) {
  const builder: PromiseLike<TableResult> & Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => result,
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as PromiseLike<TableResult> & Record<string, unknown>;
  return builder;
}

const DEFAULT_TABLE_RESULTS: Record<string, TableResult> = {
  vacancies: { data: { source_code: "greenhouse", trust_status: "VERIFIED" }, error: null },
  source_policies: { data: { discovery_allowed: true, automated_application_allowed: true }, error: null },
  automation_authorizations: { data: { status: "authorized" }, error: null },
  candidate_exclusions: { data: [], error: null },
  application_plans: { data: null, error: null },
  application_attempts: { data: [], error: null },
};

function makeClient(overrides: Partial<Record<string, TableResult>> = {}) {
  const results = { ...DEFAULT_TABLE_RESULTS, ...overrides };
  const from = vi.fn((table: string) => {
    const result = results[table];
    if (!result) {
      throw new Error(`Unexpected table: ${table}`);
    }
    return makeQueryBuilder(result);
  });
  return { from } as unknown as Parameters<typeof evaluateEligibilityGates>[0];
}

const baseInput = { candidateId: "candidate-1", vacancyId: "vacancy-1" };

describe("evaluateEligibilityGates", () => {
  it("is never eligible even when every real gate passes, because 4 gates always hard-fail", async () => {
    const client = makeClient();
    const result = await evaluateEligibilityGates(client, baseInput);

    expect(result.eligible).toBe(false);
    expect(result.gates.role_match).toEqual({ status: "fail", reasonCode: "ROLE_TAXONOMY_NOT_IMPLEMENTED" });
    expect(result.gates.verified_facts).toEqual({ status: "fail", reasonCode: "FACT_VERIFICATION_NOT_IMPLEMENTED" });
    expect(result.gates.application_support).toEqual({
      status: "fail",
      reasonCode: "APPLICATION_SUPPORT_NOT_IMPLEMENTED",
    });
    expect(result.gates.rate_and_abuse_controls).toEqual({
      status: "fail",
      reasonCode: "RATE_CONTROLS_NOT_IMPLEMENTED",
    });
  });

  describe("permanent hard-block gates", () => {
    it("application_support always fails, regardless of every other gate's outcome", async () => {
      const client = makeClient({
        vacancies: { data: { source_code: "greenhouse", trust_status: "BLOCKED" }, error: null },
        source_policies: { data: { discovery_allowed: false, automated_application_allowed: false }, error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.application_support).toEqual({
        status: "fail",
        reasonCode: "APPLICATION_SUPPORT_NOT_IMPLEMENTED",
      });
    });

    it("rate_and_abuse_controls always fails, regardless of every other gate's outcome", async () => {
      const client = makeClient({
        vacancies: { data: { source_code: "greenhouse", trust_status: "BLOCKED" }, error: null },
        source_policies: { data: { discovery_allowed: false, automated_application_allowed: false }, error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.rate_and_abuse_controls).toEqual({
        status: "fail",
        reasonCode: "RATE_CONTROLS_NOT_IMPLEMENTED",
      });
    });
  });

  describe("source_policy", () => {
    it("passes when discovery and automated application are both allowed", async () => {
      const client = makeClient();
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.source_policy).toEqual({ status: "pass" });
    });

    it("fails when automated_application_allowed is false (R2's default for every source)", async () => {
      const client = makeClient({
        source_policies: { data: { discovery_allowed: true, automated_application_allowed: false }, error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.source_policy.status).toBe("fail");
      expect(result.gates.source_policy.reasonCode).toBe("SOURCE_APPLICATION_NOT_AUTHORIZED");
    });

    it("fails when no source_policies row exists for the vacancy's source_code", async () => {
      const client = makeClient({ source_policies: { data: null, error: null } });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.source_policy).toEqual({
        status: "fail",
        reasonCode: "SOURCE_APPLICATION_NOT_AUTHORIZED",
        detail: { discoveryAllowed: false, automatedApplicationAllowed: false },
      });
    });
  });

  describe("vacancy_trust", () => {
    it("passes for VERIFIED", async () => {
      const client = makeClient({
        vacancies: { data: { source_code: "greenhouse", trust_status: "VERIFIED" }, error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.vacancy_trust).toEqual({ status: "pass" });
    });

    it("passes for VERIFIED_INCOMPLETE", async () => {
      const client = makeClient({
        vacancies: { data: { source_code: "greenhouse", trust_status: "VERIFIED_INCOMPLETE" }, error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.vacancy_trust).toEqual({ status: "pass" });
    });

    it.each(["UNDER_REVIEW", "FLAGGED", "BLOCKED", "EXPIRED_REMOVED", "ACTION_REQUIRED", null])(
      "fails for trust_status %s",
      async (trustStatus) => {
        const client = makeClient({
          vacancies: { data: { source_code: "greenhouse", trust_status: trustStatus }, error: null },
        });
        const result = await evaluateEligibilityGates(client, baseInput);
        expect(result.gates.vacancy_trust).toEqual({
          status: "fail",
          reasonCode: "VACANCY_TRUST_STATUS_INELIGIBLE",
          detail: { trustStatus },
        });
      },
    );
  });

  describe("automation_authorization", () => {
    it("passes when status is authorized", async () => {
      const client = makeClient();
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.automation_authorization).toEqual({ status: "pass" });
    });

    it.each(["paused", "stopped"])("fails when status is %s", async (status) => {
      const client = makeClient({ automation_authorizations: { data: { status }, error: null } });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.automation_authorization).toEqual({
        status: "fail",
        reasonCode: "AUTOMATION_NOT_AUTHORIZED",
        detail: { status },
      });
    });

    it("fails when the candidate has never authorized automation (no row)", async () => {
      const client = makeClient({ automation_authorizations: { data: null, error: null } });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.automation_authorization).toEqual({
        status: "fail",
        reasonCode: "AUTOMATION_NOT_AUTHORIZED",
        detail: { status: "not_yet_authorized" },
      });
    });
  });

  describe("candidate_exclusions", () => {
    it("always passes and records the candidate's excluded categories as evidence", async () => {
      const client = makeClient({
        candidate_exclusions: {
          data: [{ category: "staffing_agencies" }, { category: "relocation_required" }],
          error: null,
        },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.candidate_exclusions).toEqual({
        status: "pass",
        detail: { excludedCategories: ["staffing_agencies", "relocation_required"] },
      });
    });

    it("passes with an empty excludedCategories list when the candidate has none set", async () => {
      const client = makeClient();
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.candidate_exclusions).toEqual({ status: "pass", detail: { excludedCategories: [] } });
    });
  });

  describe("idempotency", () => {
    it("passes when no application_plans row exists yet for this candidate + vacancy", async () => {
      const client = makeClient();
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.idempotency).toEqual({ status: "pass" });
    });

    it("passes when a plan exists but every attempt has failed (safe to retry)", async () => {
      const client = makeClient({
        application_plans: { data: { id: "plan-1" }, error: null },
        application_attempts: { data: [{ status: "failed" }, { status: "failed" }], error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.idempotency).toEqual({ status: "pass" });
    });

    it("passes when a plan exists with zero attempts yet", async () => {
      const client = makeClient({
        application_plans: { data: { id: "plan-1" }, error: null },
        application_attempts: { data: [], error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.idempotency).toEqual({ status: "pass" });
    });

    it("fails when a prior attempt already succeeded", async () => {
      const client = makeClient({
        application_plans: { data: { id: "plan-1" }, error: null },
        application_attempts: { data: [{ status: "failed" }, { status: "succeeded" }], error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.idempotency).toEqual({
        status: "fail",
        reasonCode: "DUPLICATE_APPLICATION_EXISTS",
        detail: { applicationPlanId: "plan-1", blockingStatus: "succeeded" },
      });
    });

    it.each(["pending", "leased", "action_required"])("fails when an attempt is actively in-flight (%s)", async (status) => {
      const client = makeClient({
        application_plans: { data: { id: "plan-1" }, error: null },
        application_attempts: { data: [{ status }], error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.idempotency).toEqual({
        status: "fail",
        reasonCode: "DUPLICATE_APPLICATION_EXISTS",
        detail: { applicationPlanId: "plan-1", blockingStatus: status },
      });
    });
  });

  describe("error and not-found propagation", () => {
    it("throws when the vacancy does not exist", async () => {
      const client = makeClient({ vacancies: { data: null, error: null } });
      await expect(evaluateEligibilityGates(client, baseInput)).rejects.toThrow(/vacancies row not found/);
    });

    it("propagates a database error from the vacancy lookup", async () => {
      const client = makeClient({ vacancies: { data: null, error: { message: "db error" } } });
      await expect(evaluateEligibilityGates(client, baseInput)).rejects.toBeTruthy();
    });

    it("propagates a database error from the source_policies lookup", async () => {
      const client = makeClient({ source_policies: { data: null, error: { message: "db error" } } });
      await expect(evaluateEligibilityGates(client, baseInput)).rejects.toBeTruthy();
    });

    it("propagates a database error from the automation_authorizations lookup", async () => {
      const client = makeClient({ automation_authorizations: { data: null, error: { message: "db error" } } });
      await expect(evaluateEligibilityGates(client, baseInput)).rejects.toBeTruthy();
    });

    it("propagates a database error from the candidate_exclusions lookup", async () => {
      const client = makeClient({ candidate_exclusions: { data: null, error: { message: "db error" } } });
      await expect(evaluateEligibilityGates(client, baseInput)).rejects.toBeTruthy();
    });

    it("propagates a database error from the application_plans lookup", async () => {
      const client = makeClient({ application_plans: { data: null, error: { message: "db error" } } });
      await expect(evaluateEligibilityGates(client, baseInput)).rejects.toBeTruthy();
    });

    it("propagates a database error from the application_attempts lookup", async () => {
      const client = makeClient({
        application_plans: { data: { id: "plan-1" }, error: null },
        application_attempts: { data: null, error: { message: "db error" } },
      });
      await expect(evaluateEligibilityGates(client, baseInput)).rejects.toBeTruthy();
    });
  });
});
