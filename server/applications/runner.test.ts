import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./applicationEngine.js", () => ({ planApplication: vi.fn() }));
vi.mock("./worker.js", () => ({ runOneApplicationAttempt: vi.fn() }));

import { planApplication } from "./applicationEngine.js";
import { runOneApplicationAttempt } from "./worker.js";
import { runApplicationBatch } from "./runner.js";

type TableResult = { data: unknown; error: unknown };

function chain(result: TableResult) {
  const builder: Record<string, unknown> & PromiseLike<TableResult> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as Record<string, unknown> & PromiseLike<TableResult>;
  return builder;
}

/** Each table's array of results is consumed one per `.from(table)` call, in order — same convention as applicationEngine.test.ts. */
function makeClient(queues: Partial<Record<string, TableResult[]>> = {}) {
  const remaining: Record<string, TableResult[]> = {
    automation_authorizations: [],
    candidate_selected_roles: [],
    vacancies: [],
    ...queues,
  };
  const from = vi.fn((table: string) => {
    const queue = remaining[table];
    const result = queue && queue.length > 0 ? queue.shift()! : { data: [], error: null };
    return chain(result);
  });
  return { from } as unknown as Parameters<typeof runApplicationBatch>[0];
}

function authorized(candidateIds: string[]): TableResult {
  return { data: candidateIds.map((candidate_id) => ({ candidate_id })), error: null };
}

function hasRoles(candidateIds: string[]): TableResult {
  return { data: candidateIds.map((candidate_id) => ({ candidate_id })), error: null };
}

function vacancyIds(ids: string[]): TableResult {
  return { data: ids.map((id) => ({ id })), error: null };
}

beforeEach(() => {
  vi.mocked(planApplication).mockReset();
  vi.mocked(runOneApplicationAttempt).mockReset();
  vi.mocked(runOneApplicationAttempt).mockResolvedValue({ processed: false });
});

describe("runApplicationBatch — candidate/vacancy discovery", () => {
  it("only plans for candidates that are both authorized and have a selected role", async () => {
    const client = makeClient({
      automation_authorizations: [authorized(["c1", "c2"])],
      // Only c1 has a selected-role row — c2 is authorized but has none.
      candidate_selected_roles: [hasRoles(["c1"])],
      vacancies: [vacancyIds(["v1"])],
    });
    vi.mocked(planApplication).mockResolvedValue({
      applicationPlanId: "plan-1",
      eligible: false,
      gateResults: { eligible: false, gates: {} as never },
      attemptCreated: false,
    });

    const result = await runApplicationBatch(client);

    expect(planApplication).toHaveBeenCalledTimes(1);
    expect(planApplication).toHaveBeenCalledWith(client, { candidateId: "c1", vacancyId: "v1" });
    expect(result.candidateIds).toEqual(["c1"]);
  });

  it("plans every candidate x verified-vacancy pair", async () => {
    const client = makeClient({
      automation_authorizations: [authorized(["c1", "c2"])],
      candidate_selected_roles: [hasRoles(["c1", "c2"])],
      vacancies: [vacancyIds(["v1", "v2"])],
    });
    vi.mocked(planApplication).mockResolvedValue({
      applicationPlanId: "plan-x",
      eligible: false,
      gateResults: { eligible: false, gates: {} as never },
      attemptCreated: false,
    });

    const result = await runApplicationBatch(client);

    expect(planApplication).toHaveBeenCalledTimes(4);
    expect(result.vacancyIds).toEqual(["v1", "v2"]);
    expect(result.plansEvaluated).toBe(4);
  });

  it("skips planning entirely when there are no active candidates", async () => {
    const client = makeClient({
      automation_authorizations: [authorized([])],
      vacancies: [vacancyIds(["v1"])],
    });

    const result = await runApplicationBatch(client);

    expect(planApplication).not.toHaveBeenCalled();
    expect(result.plansEvaluated).toBe(0);
  });

  it("counts eligible plans separately from total plans evaluated", async () => {
    const client = makeClient({
      automation_authorizations: [authorized(["c1"])],
      candidate_selected_roles: [hasRoles(["c1"])],
      vacancies: [vacancyIds(["v1", "v2"])],
    });
    vi.mocked(planApplication)
      .mockResolvedValueOnce({
        applicationPlanId: "plan-1",
        eligible: true,
        gateResults: { eligible: true, gates: {} as never },
        applicationAttemptId: "attempt-1",
        attemptCreated: true,
      })
      .mockResolvedValueOnce({
        applicationPlanId: "plan-2",
        eligible: false,
        gateResults: { eligible: false, gates: {} as never },
        attemptCreated: false,
      });

    const result = await runApplicationBatch(client);

    expect(result.plansEvaluated).toBe(2);
    expect(result.plansEligible).toBe(1);
  });
});

describe("runApplicationBatch — planning error isolation", () => {
  it("logs and records a per-pair planning failure without stopping the remaining pairs", async () => {
    const client = makeClient({
      automation_authorizations: [authorized(["c1"])],
      candidate_selected_roles: [hasRoles(["c1"])],
      vacancies: [vacancyIds(["v1", "v2"])],
    });
    vi.mocked(planApplication)
      .mockRejectedValueOnce(new Error("vacancies row not found for id v1"))
      .mockResolvedValueOnce({
        applicationPlanId: "plan-2",
        eligible: false,
        gateResults: { eligible: false, gates: {} as never },
        attemptCreated: false,
      });

    const result = await runApplicationBatch(client);

    expect(planApplication).toHaveBeenCalledTimes(2);
    expect(result.planningFailures).toEqual([
      { candidateId: "c1", vacancyId: "v1", error: "vacancies row not found for id v1" },
    ]);
    // The second pair still got a normal plan outcome — the first pair's failure didn't abort the batch.
    expect(result.plansEvaluated).toBe(1);
  });
});

describe("runApplicationBatch — attempt drain loop", () => {
  it("drains attempts until the queue reports empty", async () => {
    const client = makeClient();
    vi.mocked(runOneApplicationAttempt)
      .mockResolvedValueOnce({ processed: true, applicationAttemptId: "a1", outcome: "succeeded" })
      .mockResolvedValueOnce({ processed: true, applicationAttemptId: "a2", outcome: "failed" })
      .mockResolvedValueOnce({ processed: false });

    const result = await runApplicationBatch(client);

    expect(runOneApplicationAttempt).toHaveBeenCalledTimes(3);
    expect(result.attemptsProcessed).toBe(2);
    expect(result.attemptDrainError).toBeUndefined();
  });

  it("stops at maxAttemptsPerBatch even if the queue still has work", async () => {
    const client = makeClient();
    vi.mocked(runOneApplicationAttempt).mockResolvedValue({
      processed: true,
      applicationAttemptId: "a1",
      outcome: "succeeded",
    });

    const result = await runApplicationBatch(client, { maxAttemptsPerBatch: 3 });

    expect(runOneApplicationAttempt).toHaveBeenCalledTimes(3);
    expect(result.attemptsProcessed).toBe(3);
  });

  it("stops the drain loop without throwing when the claim RPC itself fails", async () => {
    const client = makeClient();
    vi.mocked(runOneApplicationAttempt)
      .mockResolvedValueOnce({ processed: true, applicationAttemptId: "a1", outcome: "succeeded" })
      .mockRejectedValueOnce(new Error("claim_application_attempt RPC failed"));

    const result = await runApplicationBatch(client);

    expect(result.attemptsProcessed).toBe(1);
    expect(result.attemptDrainError).toContain("claim_application_attempt RPC failed");
  });

  it("still drains attempts even when there were no active candidates to plan", async () => {
    const client = makeClient({ automation_authorizations: [authorized([])] });
    vi.mocked(runOneApplicationAttempt)
      .mockResolvedValueOnce({ processed: true, applicationAttemptId: "a1", outcome: "succeeded" })
      .mockResolvedValueOnce({ processed: false });

    const result = await runApplicationBatch(client);

    expect(result.attemptsProcessed).toBe(1);
  });
});
