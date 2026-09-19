import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUSY_INTERVAL_MS,
  DEFAULT_ERROR_INTERVAL_MS,
  DEFAULT_IDLE_INTERVAL_MS,
  runApplicationDaemon,
} from "./daemonLoop.js";
import type { RunApplicationBatchResult } from "./runner.js";

function batch(overrides: Partial<RunApplicationBatchResult> = {}): RunApplicationBatchResult {
  return {
    candidateIds: [],
    vacancyIds: [],
    plansEvaluated: 0,
    plansEligible: 0,
    planningFailures: [],
    attemptsProcessed: 0,
    ...overrides,
  };
}

describe("interval defaults", () => {
  it("is slow when idle, immediate when busy, and backs off on error", () => {
    expect(DEFAULT_IDLE_INTERVAL_MS).toBe(30_000);
    expect(DEFAULT_BUSY_INTERVAL_MS).toBe(0);
    expect(DEFAULT_ERROR_INTERVAL_MS).toBe(5_000);
  });
});

describe("runApplicationDaemon", () => {
  it("sleeps the long idle interval when the queue was empty", async () => {
    const sleeps: number[] = [];
    let cycles = 0;

    const result = await runApplicationDaemon({
      runBatch: async () => batch({ attemptsProcessed: 0 }),
      isShuttingDown: () => cycles >= 1,
      sleep: async (ms) => {
        sleeps.push(ms);
        cycles += 1;
      },
    });

    expect(sleeps).toEqual([DEFAULT_IDLE_INTERVAL_MS]);
    expect(result.idleCycles).toBe(1);
    expect(result.attemptsProcessed).toBe(0);
    expect(result.stoppedBy).toBe("shutdown");
  });

  it("goes straight back round when the batch did work", async () => {
    const sleeps: number[] = [];
    let cycles = 0;

    const result = await runApplicationDaemon({
      runBatch: async () => batch({ attemptsProcessed: 4 }),
      isShuttingDown: () => cycles >= 1,
      sleep: async (ms) => {
        sleeps.push(ms);
        cycles += 1;
      },
    });

    expect(sleeps).toEqual([0]);
    expect(result.idleCycles).toBe(0);
    expect(result.attemptsProcessed).toBe(4);
    expect(result.batches).toBe(1);
  });

  it("treats a batch that processed nothing as idle even if it planned work", async () => {
    // plansEvaluated > 0 with attemptsProcessed === 0 is the normal state while
    // no submission adapter is registered: the planner ran, nothing was
    // eligible, so there is no reason to spin.
    const sleeps: number[] = [];
    let cycles = 0;

    const result = await runApplicationDaemon({
      runBatch: async () => batch({ plansEvaluated: 25, plansEligible: 0, attemptsProcessed: 0 }),
      isShuttingDown: () => cycles >= 1,
      sleep: async (ms) => {
        sleeps.push(ms);
        cycles += 1;
      },
    });

    expect(sleeps).toEqual([DEFAULT_IDLE_INTERVAL_MS]);
    expect(result.idleCycles).toBe(1);
  });

  it("lets an in-flight batch finish when shutdown arrives mid-batch", async () => {
    // The core graceful-shutdown guarantee: the shutdown flag is read at the
    // TOP of the cycle, so a batch that has started is never abandoned.
    let down = false;
    let batchesStarted = 0;

    const result = await runApplicationDaemon({
      runBatch: async () => {
        batchesStarted += 1;
        down = true;
        return batch({ attemptsProcessed: 3 });
      },
      isShuttingDown: () => down,
      sleep: async () => {},
    });

    expect(batchesStarted).toBe(1);
    expect(result.batches).toBe(1);
    expect(result.attemptsProcessed).toBe(3);
    expect(result.cycles).toBe(1);
  });

  it("does not run a batch at all when already shutting down", async () => {
    let batchesStarted = 0;

    const result = await runApplicationDaemon({
      runBatch: async () => {
        batchesStarted += 1;
        return batch();
      },
      isShuttingDown: () => true,
    });

    expect(batchesStarted).toBe(0);
    expect(result.cycles).toBe(0);
  });

  it("keeps running after a failed cycle instead of dying", async () => {
    const sleeps: number[] = [];
    const errors: unknown[] = [];
    let cycles = 0;
    let first = true;

    const result = await runApplicationDaemon({
      runBatch: async () => {
        if (first) {
          first = false;
          throw new Error("database is down");
        }
        return batch({ attemptsProcessed: 2 });
      },
      isShuttingDown: () => cycles >= 2,
      sleep: async (ms) => {
        sleeps.push(ms);
        cycles += 1;
      },
      log: (event, detail) => {
        if (event === "cycle failed") errors.push(detail?.error);
      },
    });

    // Error backoff first, then the busy interval after the recovered batch.
    expect(sleeps).toEqual([DEFAULT_ERROR_INTERVAL_MS, DEFAULT_BUSY_INTERVAL_MS]);
    expect(result.errorCycles).toBe(1);
    expect(result.batches).toBe(1);
    expect(result.attemptsProcessed).toBe(2);
    expect(errors).toEqual(["database is down"]);
  });

  it("accumulates counters across many cycles", async () => {
    let cycles = 0;

    const result = await runApplicationDaemon({
      runBatch: async () => batch({ attemptsProcessed: 2 }),
      isShuttingDown: () => cycles >= 3,
      sleep: async () => {
        cycles += 1;
      },
    });

    expect(result.cycles).toBe(3);
    expect(result.batches).toBe(3);
    expect(result.attemptsProcessed).toBe(6);
  });

  it("logs each completed cycle with the batch's own numbers", async () => {
    const logged: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    let cycles = 0;

    await runApplicationDaemon({
      runBatch: async () =>
        batch({
          attemptsProcessed: 1,
          plansEvaluated: 25,
          plansEligible: 0,
          planningFailures: [{ candidateId: "c", vacancyId: "v", error: "boom" }],
          attemptDrainError: "claim RPC failed",
        }),
      isShuttingDown: () => cycles >= 1,
      sleep: async () => {
        cycles += 1;
      },
      log: (event, detail) => logged.push({ event, detail }),
    });

    expect(logged).toHaveLength(1);
    expect(logged[0].event).toBe("cycle complete");
    expect(logged[0].detail).toEqual({
      attemptsProcessed: 1,
      plansEligible: 0,
      plansEvaluated: 25,
      planningFailures: 1,
      attemptDrainError: "claim RPC failed",
    });
  });

  it("omits attemptDrainError from the log when the drain was clean", async () => {
    const logged: Array<Record<string, unknown> | undefined> = [];
    let cycles = 0;

    await runApplicationDaemon({
      runBatch: async () => batch({ attemptsProcessed: 1 }),
      isShuttingDown: () => cycles >= 1,
      sleep: async () => {
        cycles += 1;
      },
      log: (_event, detail) => logged.push(detail),
    });

    expect(logged[0]).not.toHaveProperty("attemptDrainError");
  });
});
