import { createSupabaseServiceRoleClient } from "../supabaseServiceRole.js";
import { readEnvInt } from "../config/envInt.js";
import { runApplicationBatch } from "./runner.js";
import {
  DEFAULT_BUSY_INTERVAL_MS,
  DEFAULT_ERROR_INTERVAL_MS,
  DEFAULT_IDLE_INTERVAL_MS,
  runApplicationDaemon,
} from "./daemonLoop.js";

/**
 * Mini-Phase 7 — continuous worker daemon (`npm run worker:daemon`).
 *
 * Long-running counterpart to cli.ts, which does one pass and exits. This
 * process owns the lifecycle ONLY: signals, the sleep timer, the service-role
 * client. All execution stays inside the existing runApplicationBatch, which
 * claims through claim_application_attempt() and hands each attempt to
 * runOneApplicationAttempt — nothing about submission is reimplemented here.
 *
 * GRACEFUL SHUTDOWN. SIGINT/SIGTERM set a flag that the loop checks at the
 * TOP of each cycle, so a batch that has already started always runs to
 * completion. A sleep in progress is woken immediately, so an idle daemon
 * exits promptly instead of waiting out its full interval. A second signal is
 * acknowledged and ignored rather than forced — the batch still finishes.
 *
 * WHY THERE IS NO ORPHANED LOCK TO WORRY ABOUT EVEN ON SIGKILL. Each worker
 * process claims one attempt at a time via claim_application_attempt(), which
 * marks it 'leased' with a 5-minute leased_until inside its own transaction —
 * the row lock itself is released the moment that RPC returns, so nothing
 * holds a Postgres lock across the submission. A process killed mid-submission
 * leaves the attempt 'leased' until leased_until passes, after which the claim
 * query (status = 'leased' AND leased_until < now()) picks it straight back
 * up. Graceful shutdown therefore avoids abandoning an in-flight submission;
 * it is not what prevents a stuck queue, the lease is.
 *
 * Intervals are env-tunable because a drainer's cadence is exactly the thing
 * an operator needs to change without editing code — same precedent as
 * FIT_ANALYSIS_BATCH_LIMIT and INGESTION_MIN_INTERVAL_MINUTES.
 */

let shuttingDown = false;
let wakeFromSleep: (() => void) | null = null;

/** Resolves early when a shutdown is requested mid-sleep. */
function sleep(ms: number): Promise<void> {
  if (shuttingDown || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeFromSleep = null;
      resolve();
    }, ms);

    wakeFromSleep = () => {
      clearTimeout(timer);
      wakeFromSleep = null;
      resolve();
    };
  });
}

function handleSignal(signal: string) {
  if (shuttingDown) {
    console.warn(
      `[applications:daemon] ${signal} received again — a batch is still in flight; exiting as soon as it finishes.`,
    );
    return;
  }

  shuttingDown = true;
  // Accurate whether or not a batch is running: the loop reads the flag at the
  // top of a cycle, so "after the current batch" means immediately when idle.
  console.log(`[applications:daemon] ${signal} received — stopping after the current batch.`);
  wakeFromSleep?.();
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

async function main() {
  const client = createSupabaseServiceRoleClient();

  const idleIntervalMs = readEnvInt("APPLICATION_DAEMON_IDLE_MS", DEFAULT_IDLE_INTERVAL_MS);
  const errorIntervalMs = readEnvInt("APPLICATION_DAEMON_ERROR_MS", DEFAULT_ERROR_INTERVAL_MS);

  console.log("[applications:daemon] started", {
    pid: process.pid,
    idleIntervalMs,
    busyIntervalMs: DEFAULT_BUSY_INTERVAL_MS,
    errorIntervalMs,
  });

  const result = await runApplicationDaemon({
    runBatch: () => runApplicationBatch(client),
    idleIntervalMs,
    errorIntervalMs,
    isShuttingDown: () => shuttingDown,
    sleep,
    log: (event, detail) => console.log(`[applications:daemon] ${event}`, detail ?? ""),
  });

  console.log("[applications:daemon] stopped", result);
}

/**
 * The explicit exit is required, not stylistic. Letting the process end on its
 * own does NOT work here: the Supabase client holds keep-alive sockets open,
 * so the event loop never drains and the process hangs after the loop has
 * already stopped. Measured, not assumed — a shutdown probe logged "stopped"
 * correctly and was still alive 35 seconds later, which would have left
 * systemd/Kubernetes to SIGKILL it and defeated the point of a graceful stop.
 *
 * Exiting here cannot truncate anything: runApplicationDaemon only returns
 * between cycles, after the shutdown flag was read at the top of a cycle and
 * any in-flight batch had already completed.
 */
main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("[applications:daemon] fatal error", error);
    process.exit(1);
  });
