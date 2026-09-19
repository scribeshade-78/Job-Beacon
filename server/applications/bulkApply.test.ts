import { describe, expect, it, vi, beforeEach } from "vitest";
import { bulkApplyToVacancies } from "./bulkApply.js";
import { planApplication } from "./applicationEngine.js";

vi.mock("./applicationEngine.js", () => ({
  planApplication: vi.fn(),
}));

const mockedPlan = vi.mocked(planApplication);

beforeEach(() => {
  mockedPlan.mockReset();
});

function gateResults(failing: Record<string, string>) {
  const names = [
    "source_policy",
    "vacancy_trust",
    "automation_authorization",
    "candidate_exclusions",
    "idempotency",
    "role_match",
    "verified_facts",
    "application_support",
    "rate_and_abuse_controls",
  ];
  const gates: Record<string, { status: string; reasonCode?: string }> = {};
  for (const name of names) {
    gates[name] = failing[name]
      ? { status: "fail", reasonCode: failing[name] }
      : { status: "pass" };
  }
  return { eligible: Object.keys(failing).length === 0, gates };
}

const client = {} as never;

describe("bulkApplyToVacancies", () => {
  it("plans each requested vacancy and counts the eligible ones as queued", async () => {
    mockedPlan.mockImplementation(async (_client, input) => ({
      applicationPlanId: "plan-" + input.vacancyId,
      eligible: true,
      gateResults: gateResults({}) as never,
      applicationAttemptId: "attempt-" + input.vacancyId,
      attemptCreated: true,
    }));

    const result = await bulkApplyToVacancies(client, { candidateId: "cand-1", vacancyIds: ["v1", "v2"] });

    expect(result).toEqual({
      requested: 2,
      queued: 2,
      blocked: 0,
      errors: 0,
      outcomes: [
        { vacancyId: "v1", status: "queued", blockingGates: [] },
        { vacancyId: "v2", status: "queued", blockingGates: [] },
      ],
    });
    expect(mockedPlan).toHaveBeenCalledWith(client, { candidateId: "cand-1", vacancyId: "v1" });
  });

  it("counts an already-active attempt as queued, not blocked", async () => {
    // planApplication reuses an existing active attempt (attemptCreated false).
    // The work is already queued; reporting it blocked would be wrong.
    mockedPlan.mockResolvedValueOnce({
      applicationPlanId: "plan-v1",
      eligible: true,
      gateResults: gateResults({}) as never,
      applicationAttemptId: "attempt-existing",
      attemptCreated: false,
    });

    const result = await bulkApplyToVacancies(client, { candidateId: "cand-1", vacancyIds: ["v1"] });

    expect(result.queued).toBe(1);
    expect(result.outcomes[0].status).toBe("queued");
  });

  it("reports every failing gate for a blocked vacancy", async () => {
    mockedPlan.mockResolvedValueOnce({
      applicationPlanId: "plan-v1",
      eligible: false,
      gateResults: gateResults({
        source_policy: "SOURCE_APPLICATION_NOT_AUTHORIZED",
        vacancy_trust: "VACANCY_TRUST_STATUS_INELIGIBLE",
        application_support: "NO_ADAPTER_REGISTERED_FOR_SOURCE",
      }) as never,
      attemptCreated: false,
    });

    const result = await bulkApplyToVacancies(client, { candidateId: "cand-1", vacancyIds: ["v1"] });

    expect(result.blocked).toBe(1);
    expect(result.queued).toBe(0);
    expect(result.outcomes[0].blockingGates).toEqual([
      { gate: "source_policy", reasonCode: "SOURCE_APPLICATION_NOT_AUTHORIZED" },
      { gate: "vacancy_trust", reasonCode: "VACANCY_TRUST_STATUS_INELIGIBLE" },
      { gate: "application_support", reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE" },
    ]);
  });

  it("isolates a thrown error to its own vacancy and keeps planning the rest", async () => {
    mockedPlan
      .mockResolvedValueOnce({
        applicationPlanId: "plan-v1",
        eligible: false,
        gateResults: gateResults({ application_support: "NO_ADAPTER_REGISTERED_FOR_SOURCE" }) as never,
        attemptCreated: false,
      })
      .mockRejectedValueOnce(new Error("claim exploded"))
      .mockResolvedValueOnce({
        applicationPlanId: "plan-v3",
        eligible: true,
        gateResults: gateResults({}) as never,
        applicationAttemptId: "attempt-v3",
        attemptCreated: true,
      });

    const result = await bulkApplyToVacancies(client, { candidateId: "cand-1", vacancyIds: ["v1", "v2", "v3"] });

    expect(result).toEqual({
      requested: 3,
      queued: 1,
      blocked: 1,
      errors: 1,
      outcomes: [
        {
          vacancyId: "v1",
          status: "blocked",
          blockingGates: [{ gate: "application_support", reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE" }],
        },
        { vacancyId: "v2", status: "error", blockingGates: [], error: "claim exploded" },
        { vacancyId: "v3", status: "queued", blockingGates: [] },
      ],
    });
  });

  it("deduplicates repeated vacancy ids before counting", async () => {
    mockedPlan.mockResolvedValue({
      applicationPlanId: "plan",
      eligible: false,
      gateResults: gateResults({ application_support: "NO_ADAPTER_REGISTERED_FOR_SOURCE" }) as never,
      attemptCreated: false,
    });

    const result = await bulkApplyToVacancies(client, {
      candidateId: "cand-1",
      vacancyIds: ["v1", "v1", "v2", "v1"],
    });

    expect(result.requested).toBe(2);
    expect(mockedPlan).toHaveBeenCalledTimes(2);
  });

  it("handles an empty request without calling the engine", async () => {
    const result = await bulkApplyToVacancies(client, { candidateId: "cand-1", vacancyIds: [] });

    expect(result).toEqual({ requested: 0, queued: 0, blocked: 0, errors: 0, outcomes: [] });
    expect(mockedPlan).not.toHaveBeenCalled();
  });

  it("never inserts attempts itself — every outcome comes from planApplication", async () => {
    // The regression guard for the whole design: this module has no write path
    // of its own, so it cannot bypass a gate.
    mockedPlan.mockResolvedValue({
      applicationPlanId: "plan",
      eligible: true,
      gateResults: gateResults({}) as never,
      applicationAttemptId: "a",
      attemptCreated: true,
    });

    const from = vi.fn();
    await bulkApplyToVacancies({ from } as never, { candidateId: "cand-1", vacancyIds: ["v1"] });

    expect(from).not.toHaveBeenCalled();
  });
});
