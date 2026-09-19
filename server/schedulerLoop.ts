import type OpenAI from "openai";

/**
 * Task D - the autonomous scheduler's loop.
 *
 * Kept separate from scheduler.ts (which owns the process: signal handlers, the
 * service-role client, the real timer) for the same reason daemonLoop.ts is
 * separate from applications/daemon.ts: the cadence logic is testable without a
 * database, a model, or a running process. Every variable is injected.
 *
 * WHY ONE TICK LOOP RATHER THAN setInterval PER TASK. setInterval does not await
 * its callback, so a drain that outlives its own interval silently overlaps
 * itself - two fit-analysis batches racing for the same queue. Leasing makes
 * that safe but not free: the work is duplicated, the second batch claims
 * nothing, and the model is paid for twice. This loop awaits every run, so a
 * task is never concurrent with itself by construction rather than by argument.
 * One timer also means one shutdown path instead of N.
 *
 * WHY TASKS RUN SEQUENTIALLY, NOT IN PARALLEL. Both scheduled tasks call the
 * same paid model endpoint. Serialising them keeps at most one model-driven
 * batch in flight and bounds the memory of a process that is meant to sit
 * quietly in the background. The cost is explicit: a slow fit run delays the
 * anti-ghosting sweep. For a 5-minute drain against a 24-hour sweep that is
 * immaterial, and it is the honest trade rather than an accident.
 *
 * NEXT DUE IS MEASURED FROM COMPLETION, NOT FROM THE SCHEDULE. If a task starts
 * at T, takes 6 minutes, and its interval is 5 minutes, the next run is at
 * T+11m, not "immediately, because T+5m already passed". The alternative is a
 * catch-up burst that fires back-to-back runs the moment a task runs long -
 * exactly when the system is already under load.
 */

/** Backoff after a failed run, so a down database or model is not hammered. */
export const DEFAULT_ERROR_RETRY_MS = 60_000;

/**
 * Floor on a task's interval.
 *
 * Zero is a legal value to configure, and for the application daemon it means
 * something useful ("more work is queued, go straight back round"). Here it
 * would mean "claim from the database as fast as the event loop allows", which
 * is harmless while a queue is full and a self-inflicted denial of service the
 * moment it drains - a tight loop of claim RPCs against an empty queue. One
 * second keeps "run flat out" available without letting a mistyped environment
 * variable become an incident.
 */
export const MIN_TASK_INTERVAL_MS = 1_000;

export interface ScheduledTask {
  /** Stable identifier: appears in logs and in SCHEDULER_DISABLED_TASKS. */
  name: string;
  /**
   * Delay after a run COMPLETES before it runs again. Not a cron expression:
   * this scheduler is for "drain the queue regularly", where the exact wall
   * clock time is meaningless, and a fixed gap avoids the drift and overlap
   * problems an interval-plus-fixed-phase schedule would reintroduce.
   */
  intervalMs: number;
  /**
   * Runs one pass. Resolves when the pass is finished - the loop waits for it,
   * so the returned promise is what makes overlap impossible. Any object
   * returned is merged into the completion log; nothing else is done with it.
   */
  run: () => Promise<Record<string, unknown> | void>;
  /**
   * Run once at startup rather than waiting a full interval. Defaults to true:
   * the point of the scheduler is to drain the backlog that accumulated while
   * nothing was scheduled, and the first drain is the one that matters most.
   */
  runOnStart?: boolean;
}

export interface SchedulerLoopOptions {
  tasks: readonly ScheduledTask[];
  errorRetryMs?: number;
  /** Checked between tasks, never mid-run, so a started run always completes. */
  isShuttingDown?: () => boolean;
  /** Resolves early when a shutdown is requested mid-sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock, so cadence can be tested without waiting for it. */
  now?: () => number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface ScheduledTaskState {
  name: string;
  runs: number;
  failures: number;
  lastError: string | null;
}

export interface SchedulerLoopResult {
  ticks: number;
  runs: number;
  failures: number;
  tasks: ScheduledTaskState[];
  /** Always "shutdown" - the loop has no other exit. */
  stoppedBy: "shutdown";
}

/** Milliseconds until the earliest due task, clamped at zero. */
function millisUntilNextDue(
  tasks: readonly ScheduledTask[],
  nextDueAt: ReadonlyMap<string, number>,
  currentMs: number,
): number {
  let soonest = Number.POSITIVE_INFINITY;

  for (const task of tasks) {
    soonest = Math.min(soonest, nextDueAt.get(task.name) ?? currentMs);
  }

  return Number.isFinite(soonest) ? Math.max(0, soonest - currentMs) : 0;
}

export async function runSchedulerLoop(options: SchedulerLoopOptions): Promise<SchedulerLoopResult> {
  const tasks = options.tasks;
  const errorRetryMs = options.errorRetryMs ?? DEFAULT_ERROR_RETRY_MS;
  const isShuttingDown = options.isShuttingDown ?? (() => false);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});

  const states = new Map<string, ScheduledTaskState>();
  const nextDueAt = new Map<string, number>();
  const startedAtMs = now();

  const intervalOf = (task: ScheduledTask): number => Math.max(task.intervalMs, MIN_TASK_INTERVAL_MS);

  for (const task of tasks) {
    states.set(task.name, { name: task.name, runs: 0, failures: 0, lastError: null });
    nextDueAt.set(task.name, startedAtMs + (task.runOnStart === false ? intervalOf(task) : 0));
  }

  // The state objects are shared by reference, so the result reflects every
  // mutation made during the loop without a second bookkeeping structure.
  const result: SchedulerLoopResult = {
    ticks: 0,
    runs: 0,
    failures: 0,
    tasks: [...states.values()],
    stoppedBy: "shutdown",
  };

  // A task list can be empty when every task was disabled by configuration.
  // Returning immediately is load-bearing: with no tasks there is no due time
  // to sleep until, so the loop below would spin at full speed forever.
  if (tasks.length === 0) {
    log("no tasks scheduled");
    return result;
  }

  while (!isShuttingDown()) {
    result.ticks += 1;
    const currentMs = now();

    const due = tasks.filter((task) => currentMs >= (nextDueAt.get(task.name) ?? 0));

    if (due.length === 0) {
      // Sleeping exactly until the next due task, rather than polling on a fixed
      // tick, is what lets a 24-hour task coexist with a 5-minute one without
      // 17,000 pointless wake-ups a day.
      await sleep(millisUntilNextDue(tasks, nextDueAt, currentMs));
      continue;
    }

    for (const task of due) {
      // Checked between tasks so a run that has started is never interrupted -
      // the same graceful-shutdown contract the application daemon honours.
      if (isShuttingDown()) {
        break;
      }

      const state = states.get(task.name) as ScheduledTaskState;
      const runStartedAt = now();

      try {
        const summary = await task.run();
        state.runs += 1;
        state.lastError = null;
        result.runs += 1;
        log("task complete", {
          task: task.name,
          durationMs: now() - runStartedAt,
          ...(summary ?? {}),
        });
        nextDueAt.set(task.name, now() + intervalOf(task));
      } catch (error) {
        // A failed task must not kill the scheduler: a transient outage means
        // "try again shortly", not "stop all background work". The failure is
        // attributed to this task alone, so the others keep their cadence.
        const message = error instanceof Error ? error.message : String(error);
        state.failures += 1;
        state.lastError = message;
        result.failures += 1;
        log("task failed", { task: task.name, error: message, retryInMs: errorRetryMs });
        nextDueAt.set(task.name, now() + errorRetryMs);
      }
    }
  }

  return result;
}
