import { createSupabaseServiceRoleClient } from "./supabaseServiceRole.js";
import { createOpenAIClient } from "./resumes/openaiClient.js";
import { DEFAULT_ERROR_RETRY_MS, runSchedulerLoop } from "./schedulerLoop.js";
import { buildScheduledTasks } from "./schedulerTasks.js";
import { describeMailboxCapability, readMailboxCapability } from "./mailbox/capability.js";
import { readEnvInt } from "./config/envInt.js";

/**
 * Task D - the autonomous scheduler daemon (npm run scheduler).
 *
 * WHAT THIS REPLACES. Until now nothing ran the background workers: the fit
 * queue and the ghosting sweep only advanced when a human typed
 * "npm run worker:fit". This process is the missing caller. It owns the
 * lifecycle ONLY - signals, the timer, the service-role client - and delegates
 * every cycle to the same functions the CLIs and the /api/worker/* routes
 * already call. No worker logic is reimplemented here.
 *
 * WHY NOT THE EXISTING /api/worker/* ROUTES. The API server already exposes
 * POST /api/worker/run-fit (and classify-messages, match-messages), documented
 * as being "for an external scheduler". Driving those over HTTP would require
 * this process to hold WORKER_TRIGGER_SECRET and to be useless whenever the API
 * server is restarting, which under "npm run dev:server --watch" is every time a
 * server file is saved. Calling the functions directly removes a network hop, a
 * shared secret, and that coupling. The HTTP routes remain the correct surface
 * for a genuinely external cron; the two call the same code, and the workers'
 * own leasing and idempotency make it safe for both to run at once.
 *
 * WHY NOT HOOKED INTO server/index.ts. Two reasons, either sufficient. The API
 * test suite imports server/index.ts, so an import-time scheduler would start
 * timers inside every one of those tests. And dev:server runs with --watch,
 * which would restart the schedule on every keystroke rather than keeping it
 * running in the background where it belongs.
 *
 * GRACEFUL SHUTDOWN. Same contract as the application daemon: SIGINT/SIGTERM set
 * a flag the loop reads BETWEEN tasks, so a run already in flight always
 * finishes; a sleep in progress is woken immediately so an idle scheduler stops
 * promptly. A second signal is acknowledged and ignored rather than forced.
 *
 * A NOTE ON THE EXIT CODE BELOW. Configuration that leaves the scheduler with
 * nothing to do exits with code 0, not 1, and that is deliberate rather than an
 * oversight. npm run dev starts this process alongside the API and the UI under
 * "concurrently --kill-others-on-fail", which tears down the whole stack when
 * any member exits non-zero. A missing OPENROUTER_API_KEY is a reason for the
 * scheduler to stand down; it is not a reason to kill the candidate's app. The
 * message on the way out says exactly what is wrong, so the signal is the log
 * line rather than the status code.
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
      "[scheduler] " + signal + " received again - a task is still running; stopping as soon as it finishes.",
    );
    return;
  }

  shuttingDown = true;
  console.log("[scheduler] " + signal + " received - stopping after the current task.");
  wakeFromSleep?.();
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

async function main() {
  const client = createSupabaseServiceRoleClient();

  // Both scheduled tasks call the paid model endpoint, so there is no partial
  // mode in which this scheduler is useful without a key. Constructing the
  // client once, here, turns a missing key into one clear startup message
  // instead of a task failing on a loop forever.
  let openai;
  try {
    openai = createOpenAIClient();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      "[scheduler] cannot start: " + message +
        " Every scheduled task needs the model endpoint. Exiting without touching the API server.",
    );
    return;
  }

  // Optional capabilities are reported BEFORE the task list, so an operator who
  // expected to see mailbox-poll in the startup log reads why it is absent in
  // the line above it rather than guessing. Nothing here throws: a deployment
  // without Google credentials runs the other four tasks normally.
  for (const line of describeMailboxCapability(readMailboxCapability())) {
    console.warn("[scheduler] " + line);
  }

  const tasks = buildScheduledTasks(client, openai);
  const errorRetryMs = readEnvInt("SCHEDULER_ERROR_RETRY_MS", DEFAULT_ERROR_RETRY_MS);

  if (tasks.length === 0) {
    console.warn(
      "[scheduler] every task is disabled by SCHEDULER_DISABLED_TASKS - there is nothing to run. Exiting.",
    );
    return;
  }

  console.log("[scheduler] started", {
    pid: process.pid,
    errorRetryMs,
    tasks: tasks.map((task) => ({ name: task.name, intervalMs: task.intervalMs })),
  });

  const result = await runSchedulerLoop({
    tasks,
    errorRetryMs,
    isShuttingDown: () => shuttingDown,
    sleep,
    log: (event, detail) => console.log("[scheduler] " + event, detail ?? ""),
  });

  console.log("[scheduler] stopped", result);
}

/**
 * The explicit exit is required, not stylistic - the same measured finding
 * recorded in applications/daemon.ts. The Supabase client holds keep-alive
 * sockets open, so the event loop never drains and the process hangs after the
 * loop has already stopped. Exiting here cannot truncate a run:
 * runSchedulerLoop only returns between tasks.
 */
main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("[scheduler] fatal error", error);
    process.exit(1);
  });
