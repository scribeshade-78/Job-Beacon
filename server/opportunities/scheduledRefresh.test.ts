import { describe, expect, it, vi } from "vitest";
import {
  KEYLESS_SCHEDULED_SOURCE_CODES,
  readScheduledRefreshBudget,
  runScheduledDiscovery,
  runScheduledRankingRefresh,
  type ScheduledRefreshDeps,
} from "./scheduledRefresh.js";

/**
 * MOCKED COLLABORATORS. These tests exercise the SCHEDULING CONTRACT — the
 * authorization gate, the keyless-only source list, the per-tick budgets and
 * per-candidate isolation. They do NOT establish database, RLS or concurrency
 * correctness; the enumeration RPC is covered only by the UNEXECUTED pgTAP
 * fixture, and the lease/concurrency behaviour by the state-table fixture.
 */

const SUCCESS = {
  outcome: "succeeded" as const,
  phase: "matching" as const,
  state: "current",
  identity: "identity-1",
  attempts: 0,
  retryable: false,
  lastError: null,
  evidenceIndexed: 0,
  scanned: 0,
  matched: 0,
  deadlineReached: false,
};

const INTAKE_RESULT = {
  sources: [],
  received: 0,
  ingested: 0,
  created: 2,
  updated: 1,
  skippedByAdapter: 0,
  newVacancyIds: [],
  trustStatusCounts: {},
  durationMs: 1,
  failedSources: 0,
};

function deps(overrides: Partial<ScheduledRefreshDeps> = {}): ScheduledRefreshDeps {
  return {
    enumerateCandidates: vi.fn(async () => [{ candidate_id: "c-1", reason: "stale" }]),
    runRefresh: vi.fn(async () => SUCCESS),
    findActiveCandidateIds: vi.fn(async () => ["c-1"]),
    loadContext: vi.fn(async () => ({ keywords: "Data Engineer", location: "India", country: "in" })),
    runIntake: vi.fn(async () => INTAKE_RESULT),
    ...overrides,
  } as ScheduledRefreshDeps;
}

const BUDGET = { maxCandidates: 20, perCandidateDeadlineMs: 10_000, tickDeadlineMs: 120_000 };

describe("readScheduledRefreshBudget", () => {
  it("reads the documented knobs and falls back on garbage", () => {
    expect(readScheduledRefreshBudget({})).toEqual(BUDGET);
    expect(
      readScheduledRefreshBudget({
        SCHEDULER_REFRESH_MAX_CANDIDATES_PER_TICK: "5",
        SCHEDULER_REFRESH_PER_CANDIDATE_DEADLINE_MS: "-1",
        SCHEDULER_REFRESH_TICK_DEADLINE_MS: "90000",
      }),
    ).toEqual({ maxCandidates: 5, perCandidateDeadlineMs: 10_000, tickDeadlineMs: 90_000 });
  });
});

describe("runScheduledRankingRefresh", () => {
  it("runs only the candidates the RPC returned, and never forces a failed refresh", async () => {
    const runRefresh = vi.fn(async () => SUCCESS);
    const summary = await runScheduledRankingRefresh({} as never, {
      budget: BUDGET,
      deps: deps({ runRefresh }),
    });

    expect(summary.candidatesConsidered).toBe(1);
    expect(summary.completed).toBe(1);
    expect(runRefresh).toHaveBeenCalledWith(
      {},
      "c-1",
      expect.objectContaining({ force: false, deadlineMs: 10_000 }),
    );
  });

  it("stops at the per-tick candidate cap so the remainder waits for the next tick", async () => {
    const candidates = ["c-1", "c-2", "c-3", "c-4", "c-5"].map((candidate_id) => ({
      candidate_id,
      reason: "stale",
    }));
    const runRefresh = vi.fn(async () => SUCCESS);

    const summary = await runScheduledRankingRefresh({} as never, {
      budget: { ...BUDGET, maxCandidates: 2 },
      deps: deps({ enumerateCandidates: vi.fn(async () => candidates), runRefresh }),
    });

    expect(summary.candidatesConsidered).toBe(2);
    expect(runRefresh).toHaveBeenCalledTimes(2);
    expect(summary.deadlineReached).toBe(false);
  });

  it("stops at the tick deadline and reports it", async () => {
    let clock = 0;
    const runRefresh = vi.fn(async () => {
      clock += 100;
      return SUCCESS;
    });

    const summary = await runScheduledRankingRefresh({} as never, {
      budget: { ...BUDGET, tickDeadlineMs: 50 },
      now: () => clock,
      deps: deps({
        enumerateCandidates: vi.fn(async () =>
          ["c-1", "c-2", "c-3"].map((candidate_id) => ({ candidate_id, reason: "stale" })),
        ),
        runRefresh,
      }),
    });

    expect(summary.candidatesConsidered).toBe(1);
    expect(summary.deadlineReached).toBe(true);
  });

  it("counts outcomes and de-duplicates identities", async () => {
    const outcomes = [
      { ...SUCCESS, identity: "same" },
      { ...SUCCESS, identity: "same" },
      { ...SUCCESS, outcome: "running" as const, identity: null },
      { ...SUCCESS, outcome: "no_target_roles" as const, identity: null },
      { ...SUCCESS, outcome: "failed" as const, identity: "other", retryable: false },
    ];
    let index = 0;

    const summary = await runScheduledRankingRefresh({} as never, {
      budget: BUDGET,
      deps: deps({
        enumerateCandidates: vi.fn(async () =>
          outcomes.map((_, i) => ({ candidate_id: "c-" + i, reason: "stale" })),
        ),
        runRefresh: vi.fn(async () => outcomes[index++ % outcomes.length]),
      }),
    });

    expect(summary.completed).toBe(2);
    expect(summary.stillRunning).toBe(1);
    expect(summary.noTargetRoles).toBe(1);
    expect(summary.failed).toBe(1);
    // De-duplicated, but every distinct identity observed in the tick is reported.
    expect(summary.identities).toEqual(["same", "other"]);
  });

  it("isolates one candidate's infrastructure failure and keeps going", async () => {
    const runRefresh = vi.fn(async (_client: unknown, candidateId: string) => {
      if (candidateId === "c-1") throw new Error("claim RPC exploded");
      return SUCCESS;
    });

    const summary = await runScheduledRankingRefresh({} as never, {
      budget: BUDGET,
      deps: deps({
        enumerateCandidates: vi.fn(async () => [
          { candidate_id: "c-1", reason: "stale" },
          { candidate_id: "c-2", reason: "stale" },
        ]),
        runRefresh,
      }),
    });

    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(1);
  });
});

describe("runScheduledDiscovery", () => {
  it("only considers candidates the authorization gate returned, in a deterministic order", async () => {
    const runIntake = vi.fn(async () => INTAKE_RESULT);
    const loadContext = vi.fn(async (_client: unknown, _candidateId: string) => ({
      keywords: "Data Engineer",
      location: "India",
      country: "in",
    }));

    await runScheduledDiscovery({} as never, {
      budget: BUDGET,
      deps: deps({
        findActiveCandidateIds: vi.fn(async () => ["c-b", "c-a"]),
        loadContext,
        runIntake,
      }),
    });

    expect(loadContext.mock.calls.map((call) => call[1])).toEqual(["c-a", "c-b"]);
  });

  it("uses only the keyless sources and passes the candidate context through", async () => {
    const runIntake = vi.fn(async () => INTAKE_RESULT);

    await runScheduledDiscovery({} as never, {
      budget: BUDGET,
      deps: deps({ runIntake }),
    });

    expect(runIntake).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        sourceCodes: KEYLESS_SCHEDULED_SOURCE_CODES,
        keywords: "Data Engineer",
        location: "India",
        country: "in",
        deadlineMs: 10_000,
      }),
    );
    expect(KEYLESS_SCHEDULED_SOURCE_CODES).not.toContain("jooble");
    expect(KEYLESS_SCHEDULED_SOURCE_CODES).not.toContain("adzuna");
    expect(KEYLESS_SCHEDULED_SOURCE_CODES).not.toContain("serpapi");
  });

  it("isolates a candidate whose context read fails and keeps going", async () => {
    let call = 0;
    const loadContext = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("context unavailable");
      return { keywords: "Data Engineer" };
    });

    const summary = await runScheduledDiscovery({} as never, {
      budget: BUDGET,
      deps: deps({
        findActiveCandidateIds: vi.fn(async () => ["c-1", "c-2"]),
        loadContext,
      }),
    });

    expect(summary.failed).toBe(1);
    expect(summary.candidatesConsidered).toBe(2);
  });

  it("aggregates what the sources produced and stops at the cap", async () => {
    const runIntake = vi.fn(async () => ({ ...INTAKE_RESULT, created: 3, updated: 1, failedSources: 1 }));

    const summary = await runScheduledDiscovery({} as never, {
      budget: { ...BUDGET, maxCandidates: 1 },
      deps: deps({
        findActiveCandidateIds: vi.fn(async () => ["c-1", "c-2"]),
        runIntake,
      }),
    });

    expect(summary.candidatesConsidered).toBe(1);
    expect(summary.created).toBe(3);
    expect(summary.updated).toBe(1);
    expect(summary.failedSources).toBe(1);
    expect(runIntake).toHaveBeenCalledTimes(1);
  });

  it("needs no candidate at all to be a valid tick", async () => {
    const summary = await runScheduledDiscovery({} as never, {
      budget: BUDGET,
      deps: deps({ findActiveCandidateIds: vi.fn(async () => []) }),
    });

    expect(summary).toEqual({
      candidatesConsidered: 0,
      created: 0,
      updated: 0,
      failed: 0,
      failedSources: 0,
      deadlineReached: false,
    });
  });
});
