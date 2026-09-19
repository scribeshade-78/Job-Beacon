import type { RunApplicationBatchResult } from "./runner.js";

/**
 * Mini-Phase 7 — the continuous queue drainer's loop.
 *
 * Kept separate from daemon.ts (which owns the process: signal handlers, the
 * service-role client, the real timer) so the lifecycle itself is testable
 * without a database or a running process. Everything variable is injected.
 *
 * WHAT IT DOES NOT DO: it does not submit anything, and it does not touch
 * application_attempts directly. Every cycle delegates to the existing
 * runApplicationBatch, which claims work through claim_application_attempt()
 * and hands each attempt to runOneApplicationAttempt. This file is only the
 * lifecycle around that call.
 *
 * WHY THE IDLE POLL IS NOT A CHEAP "ANY PENDING ATTEMPTS?" CHECK. Tempting,
 * and wrong: runApplicationBatch does a full active-candidate x
 * verified-vacancy planning fan-out, and that fan-out is what CREATES attempts
 * in the first place. Short-circuiting on "the attempt queue is empty" would
 * skip planning, so no attempt would ever be created and the queue could never
 * fill — a deadlock that looks like an efficient optimisation. The cheap check
 * is therefore unavailable by construction, and idleness is inferred from the
 * batch's own result instead.
 */

/** Empty queue: the queue is unlikely to change soon, so this is deliberately slow. */
export const DEFAULT_IDLE_INTERVAL_MS = 30_000;
/** Work just happened: more is likely queued behind it, so go straight back round. */
export const DEFAULT_BUSY_INTERVAL_MS = 0;
/** Backoff after a failed cycle, so a down database is not hammered. */
export const DEFAULT_ERROR_INTERVAL_MS = 5_000;

export interface ApplicationDaemonOptions {
  /** Runs one batch. Injected so the loop can be tested without a database. */
  runBatch: () => Promise<RunApplicationBatchResult>;
  idleIntervalMs?: number;
  busyIntervalMs?: number;
  errorIntervalMs?: number;
  /** Checked at the TOP of each cycle, so an in-flight batch always completes. */
  isShuttingDown?: () => boolean;
  /** Resolves early when a shutdown is requested mid-sleep. */
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface ApplicationDaemonResult {
  cycles: number;
  batches: number;
  attemptsProcessed: number;
  idleCycles: number;
  errorCycles: number;
  /** Always "shutdown" — the loop has no other exit. */
  stoppedBy: "shutdown";
}

export async function runApplicationDaemon(
  options: ApplicationDaemonOptions,
): Promise<ApplicationDaemonResult> {
  const idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
  const busyIntervalMs = options.busyIntervalMs ?? DEFAULT_BUSY_INTERVAL_MS;
  const errorIntervalMs = options.errorIntervalMs ?? DEFAULT_ERROR_INTERVAL_MS;
  const isShuttingDown = options.isShuttingDown ?? (() => false);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? (() => {});

  const result: ApplicationDaemonResult = {
    cycles: 0,
    batches: 0,
    attemptsProcessed: 0,
    idleCycles: 0,
    errorCycles: 0,
    stoppedBy: "shutdown",
  };

  // Checked at the top, never mid-batch: a batch that has started is always
  // allowed to finish, which is the whole point of the graceful shutdown.
  while (!isShuttingDown()) {
    result.cycles += 1;

    let batch: RunApplicationBatchResult;
    try {
      batch = await options.runBatch();
      result.batches += 1;
      result.attemptsProcessed += batch.attemptsProcessed;
    } catch (error) {
      // A failed cycle must not kill the daemon — a transient database outage
      // should mean "try again shortly", not "stop draining the queue".
      result.errorCycles += 1;
      log("cycle failed", { error: error instanceof Error ? error.message : String(error) });
      await sleep(errorIntervalMs);
      continue;
    }

    log("cycle complete", {
      attemptsProcessed: batch.attemptsProcessed,
      plansEligible: batch.plansEligible,
      plansEvaluated: batch.plansEvaluated,
      planningFailures: batch.planningFailures.length,
      ...(batch.attemptDrainError ? { attemptDrainError: batch.attemptDrainError } : {}),
    });

    if (batch.attemptsProcessed > 0) {
      await sleep(busyIntervalMs);
      continue;
    }

    result.idleCycles += 1;
    await sleep(idleIntervalMs);
  }

  return result;
}
