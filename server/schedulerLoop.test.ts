import { describe, expect, it } from "vitest";
import {
  DEFAULT_ERROR_RETRY_MS,
  MIN_TASK_INTERVAL_MS,
  runSchedulerLoop,
} from "./schedulerLoop.js";

/**
 * The loop is tested against an injected clock and an injected sleep, so every
 * cadence assertion is exact and none of these tests waits for real time. The
 * injected sleep advances the clock, which is what makes "the next run is one
 * interval later" a statement about the loop rather than about the test runner.
 */
function harness() {
  let clock = 0;
  const sleeps: number[] = [];
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];

  return {
    sleeps,
    events,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    log: (event: string, detail?: Record<string, unknown>) => {
      events.push({ event, detail });
    },
  };
}

describe("interval defaults", () => {
  it("backs off for a minute after a failed run", () => {
    expect(DEFAULT_ERROR_RETRY_MS).toBe(60_000);
  });
});

describe("runSchedulerLoop", () => {
  it("runs every task once at startup", async () => {
    const h = harness();
    const ran: string[] = [];

    const result = await runSchedulerLoop({
      tasks: [
        { name: "a", intervalMs: 1_000, run: async () => void ran.push("a") },
        { name: "b", intervalMs: 5_000, run: async () => void ran.push("b") },
      ],
      now: h.now,
      sleep: h.sleep,
      log: h.log,
      isShuttingDown: () => h.sleeps.length >= 1,
    });

    expect(ran).toEqual(["a", "b"]);
    expect(result.runs).toBe(2);
    expect(result.stoppedBy).toBe("shutdown");
  });

  it("waits a full interval before running a task again", async () => {
    const h = harness();
    let runs = 0;

    await runSchedulerLoop({
      tasks: [{ name: "a", intervalMs: 1_000, run: async () => void (runs += 1) }],
      now: h.now,
      sleep: h.sleep,
      log: h.log,
      isShuttingDown: () => h.sleeps.length >= 2,
    });

    expect(runs).toBe(2);
    expect(h.sleeps).toEqual([1_000, 1_000]);
  });

  it("sleeps only until the soonest task, not on a fixed poll tick", async () => {
    const h = harness();

    await runSchedulerLoop({
      tasks: [
        { name: "fast", intervalMs: 1_000, run: async () => {} },
        { name: "slow", intervalMs: 3_600_000, run: async () => {} },
      ],
      now: h.now,
      sleep: h.sleep,
      log: h.log,
      isShuttingDown: () => h.sleeps.length >= 3,
    });

    // A 1-hour task must not force 1-hour granularity on a 1-second one.
    expect(h.sleeps).toEqual([1_000, 1_000, 1_000]);
  });

  it("measures the next run from completion, so a slow task cannot cause a catch-up burst", async () => {
    const h = harness();
    let runs = 0;

    await runSchedulerLoop({
      tasks: [
        {
          name: "slow",
          intervalMs: 5_000,
          run: async () => {
            runs += 1;
            // The run outlives its own interval.
            h.advance(6_000);
          },
        },
      ],
      now: h.now,
      sleep: h.sleep,
      log: h.log,
      isShuttingDown: () => h.sleeps.length >= 1,
    });

    expect(runs).toBe(1);
    // Not zero: the next due time is completion + interval, never "now, because
    // the scheduled moment already passed".
    expect(h.sleeps).toEqual([5_000]);
  });

  it("honours runOnStart false by waiting an interval first", async () => {
    const h = harness();
    let runs = 0;

    await runSchedulerLoop({
      tasks: [{ name: "a", intervalMs: 2_000, runOnStart: false, run: async () => void (runs += 1) }],
      now: h.now,
      sleep: h.sleep,
      log: h.log,
      // Two sleeps, because with runOnStart false the FIRST thing the loop does
      // must be to wait: stopping after one sleep would assert the wait without
      // ever letting the run it defers happen.
      isShuttingDown: () => h.sleeps.length >= 2,
    });

    expect(runs).toBe(1);
    expect(h.sleeps).toEqual([2_000, 2_000]);
  });

  it("never runs two tasks concurrently", async () => {
    const h = harness();
    let inFlight = 0;
    let maxInFlight = 0;

    const slow = (): Promise<void> =>
      new Promise((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        queueMicrotask(() => {
          inFlight -= 1;
          resolve();
        });
      });

    await runSchedulerLoop({
      tasks: [
        { name: "a", intervalMs: 1_000, run: slow },
        { name: "b", intervalMs: 1_000, run: slow },
      ],
      now: h.now,
      sleep: h.sleep,
      log: h.log,
      isShuttingDown: () => h.sleeps.length >= 1,
    });

    // Both tasks call the same paid endpoint; serialising them is the point.
    expect(maxInFlight).toBe(1);
  });

  it("backs a failed task off by the error interval and leaves the others alone", async () => {
    const h = harness();
    let goodRuns = 0;

    const result = await runSchedulerLoop({
      tasks: [
        {
          name: "bad",
          intervalMs: 10_000,
          run: async () => {
            throw new Error("model endpoint is down");
          },
        },
        { name: "good", intervalMs: 20_000, run: async () => void (goodRuns += 1) },
      ],
      errorRetryMs: 700,
      now: h.now,
      sleep: h.sleep,
      log: h.log,
      isShuttingDown: () => h.sleeps.length >= 1,
    });

    expect(goodRuns).toBe(1);
    expect(result.failures).toBe(1);
    expect(result.runs).toBe(1);
    // The retry is 700ms away, not the failed task's own 10s interval.
    expect(h.sleeps).toEqual([700]);

    const bad = result.tasks.find((task) => task.name === "bad");
    expect(bad?.failures).toBe(1);
    expect(bad?.lastError).toBe("model endpoint is down");
    expect(bad?.runs).toBe(0);
  });

  it("reports a non-Error throw without crashing the loop", async () => {
    const h = harness();

    const result = await runSchedulerLoop({
      tasks: [
        {
          name: "a",
          intervalMs: 1_000,
          run: async () => {
            throw "a bare string";
          },
        },
      ],
      now: h.now,
      sleep: h.sleep,
      log: h.log,
      isShuttingDown: () => h.sleeps.length >= 1,
    });

    expect(result.tasks[0]?.lastError).toBe("a bare string");
  });

  it("stops between tasks, leaving a due task unstarted", async () => {
    const h = harness();
    let shuttingDown = false;
    const ran: string[] = [];

    const result = await runSchedulerLoop({
      tasks: [
        {
          name: "first",
          intervalMs: 1_000,
          run: async () => {
            ran.push("first");
            shuttingDown = true;
          },
        },
        { name: "second", intervalMs: 1_000, run: async () => void ran.push("second") },
      ],
      now: h.now,
      sleep: h.sleep,
      log: h.log,
      isShuttingDown: () => shuttingDown,
    });

    expect(ran).toEqual(["first"]);
    expect(result.stoppedBy).toBe("shutdown");
  });

  it("returns immediately when nothing is scheduled instead of spinning", async () => {
    const h = harness();

    const result = await runSchedulerLoop({
      tasks: [],
      now: h.now,
      sleep: h.sleep,
      log: h.log,
    });

    expect(h.sleeps).toEqual([]);
    expect(result.ticks).toBe(0);
    expect(result.runs).toBe(0);
    expect(h.events.map((entry) => entry.event)).toEqual(["no tasks scheduled"]);
  });

  it("floors a zero interval so a misconfiguration cannot become a hot loop", async () => {
    const h = harness();
    let runs = 0;

    await runSchedulerLoop({
      tasks: [{ name: "a", intervalMs: 0, run: async () => void (runs += 1) }],
      now: h.now,
      sleep: h.sleep,
      log: h.log,
      isShuttingDown: () => h.sleeps.length >= 2,
    });

    // Interpreting 0 literally would claim from the database as fast as the
    // event loop allows the moment the queue drained.
    // Two sleeps means two runs: each cycle is one run followed by one wait.
    expect(runs).toBe(2);
    expect(h.sleeps).toEqual([MIN_TASK_INTERVAL_MS, MIN_TASK_INTERVAL_MS]);
  });

  it("merges whatever a task returns into its completion log", async () => {
    const h = harness();

    await runSchedulerLoop({
      tasks: [
        {
          name: "drain",
          intervalMs: 1_000,
          run: async () => ({ claimed: 5, analyzed: 4 }),
        },
      ],
      now: h.now,
      sleep: h.sleep,
      log: h.log,
      isShuttingDown: () => h.sleeps.length >= 1,
    });

    const completed = h.events.find((entry) => entry.event === "task complete");
    expect(completed?.detail).toMatchObject({ task: "drain", durationMs: 0, claimed: 5, analyzed: 4 });
  });

  it("reports per-task state for every task, including ones that never ran", async () => {
    const h = harness();
    let shuttingDown = false;

    const result = await runSchedulerLoop({
      tasks: [
        {
          name: "ran",
          intervalMs: 1_000,
          run: async () => {
            shuttingDown = true;
          },
        },
        { name: "never", intervalMs: 1_000, run: async () => {} },
      ],
      now: h.now,
      sleep: h.sleep,
      log: h.log,
      isShuttingDown: () => shuttingDown,
    });

    expect(result.tasks.map((task) => task.name)).toEqual(["ran", "never"]);
    expect(result.tasks.find((task) => task.name === "never")?.runs).toBe(0);
  });
});
