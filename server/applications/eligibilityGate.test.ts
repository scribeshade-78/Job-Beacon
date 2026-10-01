import { describe, expect, it, vi } from "vitest";

// Spies on the real resolveApplicationAdapter (default behavior unchanged
// for every existing test below) so exactly one test can inject a fake
// "supported" adapter to exercise the application_support gate's pass
// path — no real per-source adapter exists yet to test that path against.
vi.mock("./adapters/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/registry.js")>();
  return { ...actual, resolveApplicationAdapter: vi.fn(actual.resolveApplicationAdapter) };
});

import { resolveApplicationAdapter } from "./adapters/registry.js";
import type { ApplicationAdapter } from "./adapters/types.js";
import { evaluateEligibilityGates } from "./eligibilityGate.js";

type TableResult = { data: unknown; error: unknown };

/**
 * A minimal fluent builder matching exactly the call shapes
 * eligibilityGate.ts uses (.select().eq()[.eq()][.in()][.gte()][.maybeSingle()]).
 * .select()/.eq()/.in()/.gte() are no-ops that return the same builder so
 * any number of chained calls works (.in and .gte are spies so MP-RC1's
 * tests can assert on their arguments); the builder itself is thenable so
 * code that awaits without calling .maybeSingle() (the array-returning
 * queries) also resolves, mirroring real postgrest-js behavior.
 *
 * MP-RC1: application_plans is now queried two different ways within one
 * evaluateEligibilityGates call — evaluateIdempotency's `.maybeSingle()`
 * (single row or null) and evaluateRateAndAbuseControls's bare-await
 * `.eq("candidate_id", ...)` (array of this candidate's plans) — from the
 * SAME configured canned value. `.maybeSingle()` resolves the raw
 * `result` unchanged; the bare-await path auto-wraps a non-array `data`
 * into a single-element array (null -> [], one row -> [thatRow]) so one
 * `application_plans` override in a test serves both shapes consistently,
 * without every existing idempotency-focused test needing to change.
 */
function makeQueryBuilder(result: TableResult) {
  const arrayResult: TableResult = {
    ...result,
    data: result.data === null ? [] : Array.isArray(result.data) ? result.data : [result.data],
  };
  const builder: PromiseLike<TableResult> & Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    in: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    single: async () => result,
    maybeSingle: async () => result,
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(arrayResult).then(onFulfilled, onRejected),
  } as PromiseLike<TableResult> & Record<string, unknown>;
  return builder;
}

const DEFAULT_TABLE_RESULTS: Record<string, TableResult> = {
  // Task H3 registered real submission adapters for greenhouse AND lever, so
  // this default can no longer be lever: several tests below depend on the
  // default vacancy having NO application adapter, which is what makes
  // application_support fail for it. usajobs is a real configured source that
  // deliberately has no automated application channel, so it keeps those tests
  // meaning exactly what they meant.
  vacancies: { data: { source_code: "usajobs", trust_status: "VERIFIED", raw_title: "Backend Engineer" }, error: null },
  source_policies: { data: { discovery_allowed: true, automated_application_allowed: true }, error: null },
  automation_authorizations: { data: { status: "authorized" }, error: null },
  candidate_exclusions: { data: [], error: null },
  candidate_selected_roles: { data: [], error: null },
  extracted_facts: { data: [], error: null },
  fact_confirmations: { data: [], error: null },
  application_plans: { data: null, error: null },
  application_attempts: { data: [], error: null },
  // Phase 1 Task 6: the gate now loads SearchPreferences itself, and reads the
  // company name / industry for the exclusions gates. Null defaults mean "no
  // preferences row" and "no company", which is the state every pre-existing
  // test was written against.
  candidate_preferences: { data: null, error: null },
  companies: { data: null, error: null },
  company_profiles: { data: null, error: null },
  // Phase 3: the plan_entitlement gate loads the effective plan itself. Null
  // defaults mean "no subscription" -> free, with no plan_limits row -> not
  // entitled; every pre-existing test below only asserts its own gate.
  subscriptions: { data: null, error: null },
  subscription_plans: { data: null, error: null },
  plan_limits: { data: null, error: null },
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
  it("is never eligible even when every real gate (including role_match, verified_facts and rate_and_abuse_controls) passes, because application_support still hard-fails", async () => {
    const client = makeClient({
      candidate_selected_roles: { data: [{ role_name: "Backend Engineer" }], error: null },
      extracted_facts: { data: [{ id: "fact-1" }], error: null },
      fact_confirmations: { data: [{ status: "confirmed" }], error: null },
    });
    const result = await evaluateEligibilityGates(client, baseInput);

    expect(result.eligible).toBe(false);
    expect(result.gates.role_match).toEqual({ status: "pass", detail: { matchedRole: "Backend Engineer" } });
    expect(result.gates.verified_facts).toEqual({ status: "pass" });
    expect(result.gates.application_support).toEqual({
      status: "fail",
      reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE",
      detail: { sourceCode: "usajobs" },
    });
    expect(result.gates.rate_and_abuse_controls).toEqual({ status: "pass", detail: { count: 0, limit: 25 } });
  });

  describe("permanent hard-block gates", () => {
    // "for any source yet" stopped being true at Task H3, which registered real
    // adapters for greenhouse and lever. It still holds for this vacancy's
    // source, which is the point of the test.
    it("application_support fails, regardless of every other gate's outcome, when no adapter is registered for the vacancy's source", async () => {
      const client = makeClient({
        vacancies: { data: { source_code: "usajobs", trust_status: "BLOCKED", raw_title: "Backend Engineer" }, error: null },
        source_policies: { data: { discovery_allowed: false, automated_application_allowed: false }, error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.application_support).toEqual({
        status: "fail",
        reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE",
        detail: { sourceCode: "usajobs" },
      });
    });
  });

  describe("rate_and_abuse_controls (MP-RC1)", () => {
    /** Finds the application_attempts query builder instance rateAndAbuseControls itself made — the only one whose .gte was ever called (evaluateIdempotency's own application_attempts query never calls .gte). */
    function findRateLimitAttemptsBuilder(client: Parameters<typeof evaluateEligibilityGates>[0]) {
      const from = client.from as unknown as { mock: { calls: unknown[][]; results: Array<{ value: unknown }> } };
      const builders = from.mock.results
        .filter((_r, i) => from.mock.calls[i][0] === "application_attempts")
        .map((r) => r.value as { in: ReturnType<typeof vi.fn>; gte: ReturnType<typeof vi.fn> });
      return builders.find((b) => b.gte.mock.calls.length > 0);
    }

    it("passes with count 0 when the candidate has never created an application_plans row", async () => {
      const client = makeClient();
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.rate_and_abuse_controls).toEqual({ status: "pass", detail: { count: 0, limit: 25 } });
    });

    it("passes with count 0 when the candidate has a plan but no attempts in the window", async () => {
      const client = makeClient({
        application_plans: { data: { id: "plan-1" }, error: null },
        application_attempts: { data: [], error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.rate_and_abuse_controls).toEqual({ status: "pass", detail: { count: 0, limit: 25 } });
    });

    it("passes when the attempt count is below the daily limit", async () => {
      const attempts = Array.from({ length: 10 }, () => ({ status: "succeeded" }));
      const client = makeClient({
        application_plans: { data: { id: "plan-1" }, error: null },
        application_attempts: { data: attempts, error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.rate_and_abuse_controls).toEqual({ status: "pass", detail: { count: 10, limit: 25 } });
    });

    it("fails with DAILY_APPLICATION_LIMIT_EXCEEDED once the count reaches the limit", async () => {
      const attempts = Array.from({ length: 25 }, () => ({ status: "succeeded" }));
      const client = makeClient({
        application_plans: { data: { id: "plan-1" }, error: null },
        application_attempts: { data: attempts, error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.rate_and_abuse_controls).toEqual({
        status: "fail",
        reasonCode: "DAILY_APPLICATION_LIMIT_EXCEEDED",
        detail: { count: 25, limit: 25, windowHours: 24 },
      });
    });

    it("fails when the count exceeds the limit", async () => {
      const attempts = Array.from({ length: 30 }, () => ({ status: "succeeded" }));
      const client = makeClient({
        application_plans: { data: { id: "plan-1" }, error: null },
        application_attempts: { data: attempts, error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.rate_and_abuse_controls).toEqual({
        status: "fail",
        reasonCode: "DAILY_APPLICATION_LIMIT_EXCEEDED",
        detail: { count: 30, limit: 25, windowHours: 24 },
      });
    });

    it("scopes the attempts query to a rolling 24-hour window — attempts older than that never reach this count", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));

      try {
        const client = makeClient({
          application_plans: { data: { id: "plan-1" }, error: null },
          application_attempts: { data: [], error: null },
        });
        await evaluateEligibilityGates(client, baseInput);

        const rateLimitBuilder = findRateLimitAttemptsBuilder(client);
        expect(rateLimitBuilder).toBeDefined();
        expect(rateLimitBuilder!.gte).toHaveBeenCalledWith("created_at", "2026-08-23T12:00:00.000Z");
      } finally {
        vi.useRealTimers();
      }
    });

    it("excludes 'cancelled' from the statuses counted toward the limit", async () => {
      const client = makeClient({
        application_plans: { data: { id: "plan-1" }, error: null },
        application_attempts: { data: [], error: null },
      });
      await evaluateEligibilityGates(client, baseInput);

      const rateLimitBuilder = findRateLimitAttemptsBuilder(client);
      expect(rateLimitBuilder).toBeDefined();
      const statusFilterCall = rateLimitBuilder!.in.mock.calls.find((call) => call[0] === "status");
      // pending_review is included (Task U): a held attempt is an application
      // the candidate has queued and intends to send, so it counts against the
      // daily cap. Leaving it out would make the review queue a way to keep
      // unlimited applications in flight, which is the opposite of what a
      // velocity control is for.
      expect(statusFilterCall?.[1]).toEqual([
        "pending",
        "pending_review",
        "leased",
        "succeeded",
        "failed",
        "action_required",
      ]);
      expect(statusFilterCall?.[1]).not.toContain("cancelled");
    });

    it("is independent of automation_authorization — a paused candidate can still pass this gate", async () => {
      const client = makeClient({ automation_authorizations: { data: { status: "paused" }, error: null } });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.rate_and_abuse_controls).toEqual({ status: "pass", detail: { count: 0, limit: 25 } });
      expect(result.gates.automation_authorization.status).toBe("fail");
    });

    // Database-error propagation from application_plans/application_attempts (now shared
    // with evaluateIdempotency) is already covered by the "error and not-found propagation"
    // describe block below — not duplicated here.
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

  describe("application_support", () => {
    it("fails with NO_ADAPTER_REGISTERED_FOR_SOURCE for a source with no registered adapter", async () => {
      const client = makeClient();
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.application_support).toEqual({
        status: "fail",
        reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE",
        detail: { sourceCode: "usajobs" },
      });
    });

    // lever was removed from this list by Task H3: it now has a real adapter, so
    // it is no longer an example of an unregistered source.
    it.each(["adzuna", "usajobs", "remotive", "some_future_source"])(
      "fails the same way for every source_code with no registered adapter (%s)",
      async (sourceCode) => {
        const client = makeClient({
          vacancies: { data: { source_code: sourceCode, trust_status: "VERIFIED", raw_title: "Backend Engineer" }, error: null },
        });
        const result = await evaluateEligibilityGates(client, baseInput);
        expect(result.gates.application_support).toEqual({
          status: "fail",
          reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE",
          detail: { sourceCode },
        });
      },
    );

    it("passes for a greenhouse vacancy now that a real adapter is registered", async () => {
      // This file's registry mock delegates to the real resolveApplicationAdapter
      // by default, so this exercises the actual greenhouse adapter rather than
      // an injected double. Note this gate passing does NOT make a greenhouse
      // vacancy eligible: the source_policy gate independently requires
      // automated_application_allowed, which no greenhouse row sets yet.
      const client = makeClient({
        vacancies: {
          data: { source_code: "greenhouse", trust_status: "VERIFIED", raw_title: "Backend Engineer" },
          error: null,
        },
      });

      const result = await evaluateEligibilityGates(client, baseInput);

      expect(result.gates.application_support).toEqual({ status: "pass", detail: { adapter: "greenhouse" } });
    });

    it("is independent of source_policies.automated_application_allowed", async () => {
      const client = makeClient({
        source_policies: { data: { discovery_allowed: true, automated_application_allowed: true }, error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.application_support.status).toBe("fail");
      expect(result.gates.application_support.reasonCode).toBe("NO_ADAPTER_REGISTERED_FOR_SOURCE");
    });

    it("passes when the resolved adapter's validateSupport reports itself supported (MP-A1)", async () => {
      const fakeSupportedAdapter: ApplicationAdapter = {
        sourceCode: "lever",
        displayName: "Greenhouse (test double)",
        isAutomatedSubmissionSupported: true,
        validateSupport: () => ({ supported: true }),
        submit: vi.fn(),
      };
      vi.mocked(resolveApplicationAdapter).mockReturnValueOnce(fakeSupportedAdapter);

      const client = makeClient();
      const result = await evaluateEligibilityGates(client, baseInput);

      expect(result.gates.application_support).toEqual({ status: "pass", detail: { adapter: "lever" } });
    });

    it("uses the adapter's own reasonCode when validateSupport reports unsupported with a specific one", async () => {
      const fakeAdapter: ApplicationAdapter = {
        sourceCode: "lever",
        displayName: "Greenhouse (test double)",
        isAutomatedSubmissionSupported: false,
        validateSupport: () => ({ supported: false, reasonCode: "MISSING_EMPLOYER_CREDENTIALS" }),
        submit: vi.fn(),
      };
      vi.mocked(resolveApplicationAdapter).mockReturnValueOnce(fakeAdapter);

      // The vacancy's own source is stated rather than taken from the default
      // fixture, so this test keeps describing the adapter it injects.
      const client = makeClient({
        vacancies: { data: { source_code: "lever", trust_status: "VERIFIED", raw_title: "Backend Engineer" }, error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);

      expect(result.gates.application_support).toEqual({
        status: "fail",
        reasonCode: "MISSING_EMPLOYER_CREDENTIALS",
        detail: { sourceCode: "lever" },
      });
    });

    it("passes candidateId and the vacancy fields through to validateSupport", async () => {
      const validateSupport = vi.fn().mockReturnValue({ supported: true });
      const fakeAdapter: ApplicationAdapter = {
        sourceCode: "lever",
        displayName: "Greenhouse (test double)",
        isAutomatedSubmissionSupported: true,
        validateSupport,
        submit: vi.fn(),
      };
      vi.mocked(resolveApplicationAdapter).mockReturnValueOnce(fakeAdapter);

      const client = makeClient({
        vacancies: { data: { source_code: "lever", trust_status: "VERIFIED", raw_title: "Backend Engineer" }, error: null },
      });
      await evaluateEligibilityGates(client, baseInput);

      expect(validateSupport).toHaveBeenCalledWith({
        vacancy: { sourceCode: "lever", trustStatus: "VERIFIED", rawTitle: "Backend Engineer" },
        candidateId: "candidate-1",
      });
    });
  });

  describe("vacancy_trust", () => {
    it("passes for VERIFIED", async () => {
      const client = makeClient({
        vacancies: { data: { source_code: "lever", trust_status: "VERIFIED", raw_title: "Backend Engineer" }, error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.vacancy_trust).toEqual({ status: "pass" });
    });

    it("passes for VERIFIED_INCOMPLETE", async () => {
      const client = makeClient({
        vacancies: {
          data: { source_code: "lever", trust_status: "VERIFIED_INCOMPLETE", raw_title: "Backend Engineer" },
          error: null,
        },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.vacancy_trust).toEqual({ status: "pass" });
    });

    it.each(["UNDER_REVIEW", "FLAGGED", "BLOCKED", "EXPIRED_REMOVED", "ACTION_REQUIRED", null])(
      "fails for trust_status %s",
      async (trustStatus) => {
        const client = makeClient({
          vacancies: {
            data: { source_code: "lever", trust_status: trustStatus, raw_title: "Backend Engineer" },
            error: null,
          },
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

  describe("role_match", () => {
    it("fails when the candidate has selected no roles", async () => {
      const client = makeClient();
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.role_match).toEqual({ status: "fail", reasonCode: "NO_ROLES_SELECTED" });
    });

    it("passes on an exact (case-insensitive) match", async () => {
      const client = makeClient({
        candidate_selected_roles: { data: [{ role_name: "backend engineer" }], error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.role_match).toEqual({ status: "pass", detail: { matchedRole: "backend engineer" } });
    });

    it("passes when a selected role is a substring of the vacancy's raw_title", async () => {
      const client = makeClient({
        vacancies: {
          data: { source_code: "lever", trust_status: "VERIFIED", raw_title: "Senior Backend Engineer II" },
          error: null,
        },
        candidate_selected_roles: { data: [{ role_name: "Backend Engineer" }], error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.role_match).toEqual({ status: "pass", detail: { matchedRole: "Backend Engineer" } });
    });

    it("passes when any one of several selected roles matches", async () => {
      const client = makeClient({
        candidate_selected_roles: {
          data: [{ role_name: "Data Analyst" }, { role_name: "Backend Engineer" }],
          error: null,
        },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.role_match).toEqual({ status: "pass", detail: { matchedRole: "Backend Engineer" } });
    });

    it("fails, with the selected roles as evidence, when none of them match", async () => {
      const client = makeClient({
        candidate_selected_roles: {
          data: [{ role_name: "Data Analyst" }, { role_name: "Product Manager" }],
          error: null,
        },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.role_match).toEqual({
        status: "fail",
        reasonCode: "ROLE_NOT_MATCHED",
        detail: { selectedRoles: ["Data Analyst", "Product Manager"] },
      });
    });

    it("treats a blank role name as no role at all", async () => {
      const client = makeClient({
        candidate_selected_roles: { data: [{ role_name: "   " }], error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      // The unified SearchPreferences trims and drops blank entries, so a blank
      // role is indistinguishable from having selected none — and it still does
      // not match every vacancy title.
      expect(result.gates.role_match).toEqual({ status: "fail", reasonCode: "NO_ROLES_SELECTED" });
    });
  });

  describe("verified_facts", () => {
    it("fails when the candidate has no extracted facts at all", async () => {
      const client = makeClient();
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.verified_facts).toEqual({ status: "fail", reasonCode: "NO_FACTS_EXTRACTED" });
    });

    it("fails when facts exist but none are confirmed", async () => {
      const client = makeClient({
        extracted_facts: { data: [{ id: "fact-1" }, { id: "fact-2" }], error: null },
        fact_confirmations: { data: [{ status: "pending" }, { status: "rejected" }], error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.verified_facts).toEqual({ status: "fail", reasonCode: "NO_FACTS_CONFIRMED" });
    });

    it("passes when at least one fact is confirmed", async () => {
      const client = makeClient({
        extracted_facts: { data: [{ id: "fact-1" }, { id: "fact-2" }], error: null },
        fact_confirmations: { data: [{ status: "pending" }, { status: "confirmed" }], error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.verified_facts).toEqual({ status: "pass" });
    });

    it("fails when facts exist but have no confirmation rows yet", async () => {
      const client = makeClient({
        extracted_facts: { data: [{ id: "fact-1" }], error: null },
        fact_confirmations: { data: [], error: null },
      });
      const result = await evaluateEligibilityGates(client, baseInput);
      expect(result.gates.verified_facts).toEqual({ status: "fail", reasonCode: "NO_FACTS_CONFIRMED" });
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

    it("propagates a database error from the candidate_selected_roles lookup", async () => {
      const client = makeClient({ candidate_selected_roles: { data: null, error: { message: "db error" } } });
      await expect(evaluateEligibilityGates(client, baseInput)).rejects.toBeTruthy();
    });

    it("propagates a database error from the extracted_facts lookup", async () => {
      const client = makeClient({ extracted_facts: { data: null, error: { message: "db error" } } });
      await expect(evaluateEligibilityGates(client, baseInput)).rejects.toBeTruthy();
    });

    it("propagates a database error from the fact_confirmations lookup", async () => {
      const client = makeClient({
        extracted_facts: { data: [{ id: "fact-1" }], error: null },
        fact_confirmations: { data: null, error: { message: "db error" } },
      });
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

describe("search preference gates", () => {
  /**
   * A vacancy + preferences+roles fixture where every gate passes, so each test
   * below can change exactly one thing and show which gate caught it.
   */
  const fullyEligible = {
    vacancies: {
      data: {
        source_code: "greenhouse",
        trust_status: "VERIFIED",
        raw_title: "Backend Engineer",
        company_id: "company-1",
        country: "India",
        city: "Bengaluru",
        remote_type: "remote",
        salary_max: 90000,
        currency: "USD",
      },
      error: null,
    },
    source_policies: { data: { discovery_allowed: true, automated_application_allowed: true }, error: null },
    candidate_preferences: {
      data: {
        preferred_countries: ["India"],
        preferred_cities: [],
        remote_preference: "remote",
        employment_types: [],
        min_salary: 60000,
        min_salary_currency: "USD",
        open_to_any_location: false,
        excluded_companies: ["Acme Corp"],
        excluded_industries: ["Gambling"],
      },
      error: null,
    },
    candidate_selected_roles: { data: [{ role_name: "Backend Engineer" }], error: null },
    extracted_facts: { data: [{ id: "fact-1" }], error: null },
    fact_confirmations: { data: [{ status: "confirmed" }], error: null },
    companies: { data: { displayed_name: "Contoso" }, error: null },
    company_profiles: { data: { industry: "Software" }, error: null },
    subscriptions: { data: { plan_id: "plan-pro" }, error: null },
    subscription_plans: { data: { id: "plan-pro", code: "pro" }, error: null },
    plan_limits: { data: { max_auto_apply_india_per_month: 100, max_auto_apply_us_per_month: 300 }, error: null },
  };

  it("passes and queues a job that satisfies every search preference", async () => {
    const result = await evaluateEligibilityGates(makeClient(fullyEligible), baseInput);

    expect(result.eligible).toBe(true);
    expect(result.gates.role_match).toEqual({ status: "pass", detail: { matchedRole: "Backend Engineer" } });
    expect(result.gates.excluded_company).toEqual({ status: "pass" });
    expect(result.gates.excluded_industry).toEqual({ status: "pass" });
    expect(result.gates.work_mode).toEqual({ status: "pass" });
    expect(result.gates.salary).toEqual({ status: "pass" });
    expect(result.gates.location).toEqual({ status: "pass" });
  });

  it("rejects a title that only matches by substring", async () => {
    // "Metadata Analyst" contains the letters of "Data Analyst" but not its
    // words; the old substring gate passed this, the tokenized matcher does not.
    const result = await evaluateEligibilityGates(
      makeClient({
        ...fullyEligible,
        vacancies: { data: { ...fullyEligible.vacancies.data, raw_title: "Metadata Analyst" }, error: null },
        candidate_selected_roles: { data: [{ role_name: "Data Analyst" }], error: null },
      }),
      baseInput,
    );

    expect(result.eligible).toBe(false);
    expect(result.gates.role_match).toEqual({
      status: "fail",
      reasonCode: "ROLE_NOT_MATCHED",
      detail: { selectedRoles: ["Data Analyst"] },
    });
  });

  it("rejects a work mode that does not match the stated preference", async () => {
    const result = await evaluateEligibilityGates(
      makeClient({
        ...fullyEligible,
        vacancies: { data: { ...fullyEligible.vacancies.data, remote_type: "on_site" }, error: null },
      }),
      baseInput,
    );

    expect(result.eligible).toBe(false);
    expect(result.gates.work_mode?.status).toBe("fail");
    expect(result.gates.work_mode?.reasonCode).toBe("work_mode_mismatch");
  });

  it("rejects a salary below the stated floor", async () => {
    const result = await evaluateEligibilityGates(
      makeClient({
        ...fullyEligible,
        vacancies: { data: { ...fullyEligible.vacancies.data, salary_max: 50000 }, error: null },
      }),
      baseInput,
    );

    expect(result.eligible).toBe(false);
    expect(result.gates.salary?.status).toBe("fail");
    expect(result.gates.salary?.reasonCode).toBe("below_min_salary");
  });

  it("rejects a company the candidate excluded, case-insensitively", async () => {
    const result = await evaluateEligibilityGates(
      makeClient({
        ...fullyEligible,
        companies: { data: { displayed_name: "acme corp" }, error: null },
      }),
      baseInput,
    );

    expect(result.eligible).toBe(false);
    expect(result.gates.excluded_company?.status).toBe("fail");
    expect(result.gates.excluded_company?.reasonCode).toBe("excluded_company");
  });

  it("rejects an industry the candidate excluded, case-insensitively", async () => {
    const result = await evaluateEligibilityGates(
      makeClient({
        ...fullyEligible,
        company_profiles: { data: { industry: "gambling" }, error: null },
      }),
      baseInput,
    );

    expect(result.eligible).toBe(false);
    expect(result.gates.excluded_industry?.status).toBe("fail");
    expect(result.gates.excluded_industry?.reasonCode).toBe("excluded_industry");
  });

  it("does not exclude a company with no company_profiles row", async () => {
    const result = await evaluateEligibilityGates(
      makeClient({
        ...fullyEligible,
        company_profiles: { data: null, error: null },
      }),
      baseInput,
    );

    // No evidence of an excluded industry is not an exclusion.
    expect(result.gates.excluded_industry).toEqual({ status: "pass" });
    expect(result.eligible).toBe(true);
  });

  it("rejects a job outside the stated locations", async () => {
    const result = await evaluateEligibilityGates(
      makeClient({
        ...fullyEligible,
        vacancies: {
          data: { ...fullyEligible.vacancies.data, country: "Germany", city: "Berlin" },
          error: null,
        },
      }),
      baseInput,
    );

    expect(result.eligible).toBe(false);
    expect(result.gates.location?.status).toBe("fail");
    expect(result.gates.location?.reasonCode).toBe("location_mismatch");
  });

  it("rejects with location_not_stated when the candidate never stated a location", async () => {
    const result = await evaluateEligibilityGates(
      makeClient({
        ...fullyEligible,
        candidate_preferences: {
          data: {
            ...fullyEligible.candidate_preferences.data,
            preferred_countries: [],
            preferred_cities: [],
            open_to_any_location: false,
          },
          error: null,
        },
      }),
      baseInput,
    );

    expect(result.eligible).toBe(false);
    expect(result.gates.location?.status).toBe("fail");
    expect(result.gates.location?.reasonCode).toBe("location_not_stated");
  });

  it("ignores a forged payload and uses the database preferences", async () => {
    // The caller cannot claim their way past the gate: the gate loads both
    // tables itself from the authenticated candidate id, so the DB's role and
    // salary floor win over anything in the request.
    const client = makeClient({
      ...fullyEligible,
      candidate_selected_roles: { data: [{ role_name: "Data Analyst" }], error: null },
      candidate_preferences: {
        data: { ...fullyEligible.candidate_preferences.data, min_salary: 500000 },
        error: null,
      },
    });

    const forged = {
      candidateId: "candidate-1",
      vacancyId: "vacancy-1",
      targetRoles: ["Backend Engineer"],
      workMode: "any",
      salary: { min: null, currency: null },
    } as unknown as Parameters<typeof evaluateEligibilityGates>[1];

    const result = await evaluateEligibilityGates(client, forged);

    expect(result.eligible).toBe(false);
    expect(result.gates.role_match.reasonCode).toBe("ROLE_NOT_MATCHED");
    expect(result.gates.salary?.reasonCode).toBe("below_min_salary");
  });
});

describe("plan entitlement gate", () => {
  /** Every other gate in a passing state, so these tests isolate the plan gate. */
  const otherwiseEligible = {
    vacancies: {
      data: {
        source_code: "greenhouse",
        trust_status: "VERIFIED",
        raw_title: "Backend Engineer",
        company_id: "company-1",
        country: "India",
        city: "Bengaluru",
        remote_type: "remote",
        salary_max: 90000,
        currency: "USD",
      },
      error: null,
    },
    source_policies: { data: { discovery_allowed: true, automated_application_allowed: true }, error: null },
    candidate_preferences: {
      data: {
        preferred_countries: ["India"],
        preferred_cities: [],
        remote_preference: "remote",
        employment_types: [],
        min_salary: 60000,
        min_salary_currency: "USD",
        open_to_any_location: false,
        excluded_companies: [],
        excluded_industries: [],
      },
      error: null,
    },
    candidate_selected_roles: { data: [{ role_name: "Backend Engineer" }], error: null },
    extracted_facts: { data: [{ id: "fact-1" }], error: null },
    fact_confirmations: { data: [{ status: "confirmed" }], error: null },
    companies: { data: { displayed_name: "Contoso" }, error: null },
    company_profiles: { data: { industry: "Software" }, error: null },
  };

  const paidPlan = {
    subscriptions: { data: { plan_id: "plan-pro" }, error: null },
    subscription_plans: { data: { id: "plan-pro", code: "pro" }, error: null },
    plan_limits: { data: { max_auto_apply_india_per_month: 100, max_auto_apply_us_per_month: 300 }, error: null },
  };

  const freePlan = {
    subscriptions: { data: null, error: null },
    subscription_plans: { data: { id: "plan-free", code: "free" }, error: null },
    plan_limits: { data: { max_auto_apply_india_per_month: 0, max_auto_apply_us_per_month: 0 }, error: null },
  };

  it("passes and queues for a paid plan with a non-zero allowance", async () => {
    const result = await evaluateEligibilityGates(makeClient({ ...otherwiseEligible, ...paidPlan }), baseInput);

    expect(result.eligible).toBe(true);
    expect(result.gates.plan_entitlement).toEqual({ status: "pass" });
  });

  it("rejects a Free candidate (no subscription) with plan_not_eligible", async () => {
    const result = await evaluateEligibilityGates(makeClient({ ...otherwiseEligible, ...freePlan }), baseInput);

    expect(result.eligible).toBe(false);
    expect(result.gates.plan_entitlement).toEqual({
      status: "fail",
      reasonCode: "plan_not_eligible",
      detail: { planCode: "free" },
    });
  });

  it("is entitled when only one destination quota is non-zero", async () => {
    const result = await evaluateEligibilityGates(
      makeClient({
        ...otherwiseEligible,
        subscriptions: { data: { plan_id: "plan-us" }, error: null },
        subscription_plans: { data: { id: "plan-us", code: "starter" }, error: null },
        plan_limits: { data: { max_auto_apply_india_per_month: 0, max_auto_apply_us_per_month: 80 }, error: null },
      }),
      baseInput,
    );

    expect(result.gates.plan_entitlement).toEqual({ status: "pass" });
  });

  it("rejects when the effective plan has no plan_limits row", async () => {
    const result = await evaluateEligibilityGates(
      makeClient({ ...otherwiseEligible, ...paidPlan, plan_limits: { data: null, error: null } }),
      baseInput,
    );

    expect(result.gates.plan_entitlement).toEqual({
      status: "fail",
      reasonCode: "plan_not_eligible",
      detail: { planCode: "pro" },
    });
  });

  it("ignores a forged payload and uses the database entitlement", async () => {
    const forged = {
      candidateId: "candidate-1",
      vacancyId: "vacancy-1",
      planEntitled: true,
      plan: "power",
    } as unknown as Parameters<typeof evaluateEligibilityGates>[1];

    const result = await evaluateEligibilityGates(makeClient({ ...otherwiseEligible, ...freePlan }), forged);

    expect(result.eligible).toBe(false);
    expect(result.gates.plan_entitlement?.reasonCode).toBe("plan_not_eligible");
  });
});
