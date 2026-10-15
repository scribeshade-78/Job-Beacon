import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { runFitAnalysisBatch } from "./opportunities/runner.js";
import { reconcileFitAnalyses } from "./opportunities/reconcile.js";
import { drainIngestionJobs, enqueueIngestionBatch } from "./ingestion/runner.js";
import { drainIntakeRefreshJobs } from "./intake/refreshQueue.js";
import {
  KEYLESS_SCHEDULED_SOURCE_CODES,
  readScheduledRefreshBudget,
  runScheduledRankingRefresh,
} from "./opportunities/scheduledRefresh.js";
import { DEFAULT_DRAFT_LIMIT, DEFAULT_MIN_AGE_DAYS, runFollowUpSweep } from "./mailbox/antiGhosting.js";
import { runMailboxPollingBatch } from "./mailbox/poll.js";
import { runMessageClassificationBatch } from "./mailbox/classifyBatch.js";
import { runApplicationMatchBatch } from "./mailbox/matchBatch.js";
import { readGoogleOAuthConfig } from "./mailbox/oauth.js";
import { readMailboxEncryptionKey } from "./mailbox/tokenCrypto.js";
import { readMailboxCapability } from "./mailbox/capability.js";
import { runCalendarSyncBatch } from "./calendar/sync.js";
import { readEnvInt } from "./config/envInt.js";
import type { ScheduledTask } from "./schedulerLoop.js";

/**
 * Task D - what the scheduler actually runs.
 *
 * Separated from scheduler.ts for the same reason the loop is: scheduler.ts
 * calls main() at module load, so anything importable-for-testing has to live
 * outside it. This module defines the tasks; the entry point owns the process.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 * No application submission. runApplicationBatch is already a continuous daemon
 * (npm run worker:daemon) and, more importantly, putting it on a timer would
 * mean applications leaving the building on a schedule the candidate never
 * approved. Submission stays behind its own explicit trigger.
 *
 * INGESTION IS HERE NOW, AND THAT IS A RECENT CHANGE - the original position was "no
 * ingestion and no mailbox polling: both reach the network and need credentials this
 * scheduler does not have to own, and neither was asked for." Mailbox polling arrived with
 * Google OAuth. Ingestion arrives because of a MEASURED DEFECT rather than a preference:
 *
 *   POST /api/opportunities/refresh used to AWAIT the whole batch. One job is one board,
 *   and boards are not small - a real Stripe board of 726 postings took 392s end to end
 *   (measured, scripts/discovery-live.ts) against ~42s for Vercel's 90. No browser, proxy
 *   or gateway holds a request open that long, so the candidate was shown a failure while
 *   the work carried on and succeeded. Draining moves here, where overrunning costs a tick
 *   instead of a user's request; the route now enqueues and returns 202.
 *
 * THE DEADLINE IS CHECKED BETWEEN JOBS, NOT DURING ONE, so a single oversized board can
 * still overrun a tick. Bounding a job in flight is possible but NOT safe on its own:
 * worker.ts calls markUnseenVacanciesExpired after ingesting, so stopping a fetch early
 * would mark every not-yet-reached vacancy EXPIRED - live jobs vanishing from the feed.
 * An in-flight deadline has to suppress that sweep, and that is a separate change.
 *
 * Both tasks that ARE here are drains of a queue that something else fills, and
 * both are idempotent: fit_analysis_jobs is leased with FOR UPDATE SKIP LOCKED,
 * and the ghosting detector excludes attempts that already have a draft. Running
 * them more often than intended cannot double-apply anything.
 */

/** The brief's cadence: drain pending fit analysis every five minutes. */
export const DEFAULT_FIT_INTERVAL_MS = 5 * 60_000;

/**
 * How often the fit BACK-FILL runs.
 *
 * Slower than the five-minute drain on purpose. The pass is a full
 * (candidates x eligible vacancies) scan whose only output is a queue that the drain then
 * works through, so running it as often as the drain would re-scan the same matrix to
 * re-enqueue pairs that are already pending. Thirty minutes keeps the tail moving without
 * turning the scan into a poller.
 *
 * SINCE THE FAN-OUT CAP (20261016090000) THIS CADENCE IS LOAD-BEARING. The triggers queue
 * only the newest 200 eligible vacancies per candidate action, so this pass is the only
 * thing that ever scores the rest.
 */
export const DEFAULT_FIT_RECONCILE_INTERVAL_MS = 30 * 60_000;

/**
 * The brief allows 12 or 24 hours; 24 is the default because the detector's own
 * window is 7 days. A sweep every 12 hours would re-ask a question whose answer
 * cannot have changed for at least a day, and the "already drafted" exclusion
 * means the second run of any day is guaranteed to find nothing new. Twelve
 * hours is one environment variable away (SCHEDULER_ANTI_GHOSTING_INTERVAL_MS).
 */
export const DEFAULT_ANTI_GHOSTING_INTERVAL_MS = 24 * 60 * 60_000;

export const FIT_TASK_NAME = "fit-analysis";
export const FIT_RECONCILE_TASK_NAME = "fit-reconcile";
export const RANKING_REFRESH_TASK_NAME = "ranking-refresh";
export const ANTI_GHOSTING_TASK_NAME = "anti-ghosting";
export const MAILBOX_POLL_TASK_NAME = "mailbox-poll";
export const MAILBOX_CLASSIFY_TASK_NAME = "mailbox-classify";
export const MAILBOX_MATCH_TASK_NAME = "mailbox-match";
export const CALENDAR_SYNC_TASK_NAME = "calendar-sync";
export const INGESTION_DRAIN_TASK_NAME = "ingestion-drain";
export const INTAKE_REFRESH_DRAIN_TASK_NAME = "intake-refresh-drain";
export const KEYLESS_INGESTION_ENQUEUE_TASK_NAME = "keyless-ingestion-enqueue";

/**
 * How often queued discovery work is drained.
 *
 * Short is cheap: an empty queue is a single no-op claim, so a cadence faster than the work
 * arrives costs one round trip. Two minutes keeps a button press feeling responsive without
 * turning the scheduler into a poller.
 */
export const DEFAULT_INGESTION_DRAIN_INTERVAL_MS = 2 * 60_000;

/** Caps jobs per tick. The queue is normally near-empty, so this is a backstop, not a target. */
export const DEFAULT_INGESTION_DRAIN_MAX_JOBS = 5;

/**
 * Wall-clock budget for the drain, well inside the 5-minute claim lease.
 *
 * A job whose lease expires while still running becomes claimable again, and a second
 * worker would start a duplicate fetch of the same board. Staying under the lease is what
 * keeps one slow board from being fetched twice.
 */
export const DEFAULT_INGESTION_DRAIN_DEADLINE_MS = 4 * 60_000;

/**
 * How often a candidate's queued "Fetch latest jobs" press is drained.
 *
 * Sixty seconds, not the ingestion drain's two minutes: this queue is filled by a
 * candidate who is watching, and an empty claim is a single RPC. A tick that finds no
 * work costs one round trip; a tick that finds work spends as long as the fan-out takes,
 * and the next tick simply waits for it.
 */
export const DEFAULT_INTAKE_REFRESH_DRAIN_INTERVAL_MS = 60_000;

/**
 * How often the unattended path tops up the ingestion queue with the keyless public
 * sources.
 *
 * CONSERVATIVE ON PURPOSE: four runs a day. This
 * task only ENQUEUES - the network cost is paid by the ingestion drain, whose per-target
 * cooldown is the real guard - but the cadence decides how often each of those public
 * APIs is swept, and they are somebody else's free infrastructure.
 */
export const DEFAULT_KEYLESS_INGESTION_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Mail polling every five minutes, matching POLL_INTERVAL_MS inside poll.ts:
 * that constant is the connection's own next-eligible floor, so a scheduler
 * faster than it would just find nothing claimable.
 */
export const DEFAULT_MAILBOX_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * Classification and matching share the poll's cadence but run AFTER it in the
 * task array, which matters: the scheduler executes due tasks in order, so a
 * message fetched by the poll in the same tick is classified and matched in that
 * same tick rather than waiting another interval.
 *
 * Neither needs Google credentials. They operate on messages already stored, so
 * they keep working — and keep draining a backlog — on a deployment where
 * Google is not configured at all.
 */
export const DEFAULT_MAILBOX_CLASSIFY_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_MAILBOX_MATCH_INTERVAL_MS = 5 * 60_000;

/**
 * Calendar changes are far less frequent than mail and each sync is one
 * incremental API call, so a slower cadence costs nothing in freshness while
 * halving the request volume. Ten minutes is the compromise.
 */
export const DEFAULT_CALENDAR_SYNC_INTERVAL_MS = 10 * 60_000;

/**
 * Batch C — the scheduled preference-ranking refresh. DB-only over each
 * candidate's own rows, so ten minutes keeps a live feed current without any
 * third-party request, model call or submission.
 */
export const DEFAULT_RANKING_REFRESH_INTERVAL_MS = 10 * 60_000;


/**
 * Parses SCHEDULER_DISABLED_TASKS, a comma-separated list of task names.
 *
 * Exists so a paid, model-backed task can be turned off for an afternoon
 * without editing code or commenting out an array entry - the same reason the
 * intervals are environment variables. Unknown names are ignored rather than
 * rejected: a typo should leave the scheduler running, and the startup log
 * prints exactly which tasks are live.
 */
export function parseDisabledTasks(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
}

/**
 * Gmail polling.
 *
 * Constructed only when the capability probe says Google is configured, so
 * readGoogleOAuthConfig/readMailboxEncryptionKey cannot throw here. They are
 * still called inside run() rather than captured at construction, so a
 * misconfiguration surfaces as one failed cycle carrying its own reason rather
 * than as a task built from a value frozen at startup.
 */
function mailboxPollTask(
  client: SupabaseClient,
  openai: Pick<OpenAI, "chat">,
  env: Record<string, string | undefined>,
): ScheduledTask {
  return {
    name: MAILBOX_POLL_TASK_NAME,
    intervalMs: readEnvInt("SCHEDULER_MAILBOX_POLL_INTERVAL_MS", DEFAULT_MAILBOX_POLL_INTERVAL_MS, env),
    run: async () => {
      const result = await runMailboxPollingBatch(
        client,
        readGoogleOAuthConfig(env),
        readMailboxEncryptionKey(env),
        fetch,
        openai,
      );

      return {
        claimed: result.claimed,
        succeeded: result.succeeded,
        transientErrors: result.transientErrors,
        terminalErrors: result.terminalErrors,
      };
    },
  };
}

/**
 * Message classification. Does NOT need Google credentials: it works over
 * messages already stored, so it keeps draining a backlog on a deployment where
 * mailbox polling is disabled entirely.
 */
function mailboxClassifyTask(
  client: SupabaseClient,
  openai: Pick<OpenAI, "chat">,
  env: Record<string, string | undefined>,
): ScheduledTask {
  return {
    name: MAILBOX_CLASSIFY_TASK_NAME,
    intervalMs: readEnvInt("SCHEDULER_MAILBOX_CLASSIFY_INTERVAL_MS", DEFAULT_MAILBOX_CLASSIFY_INTERVAL_MS, env),
    run: async () => {
      const result = await runMessageClassificationBatch(client, openai, {
        limit: env.MESSAGE_CLASSIFY_BATCH_LIMIT
          ? Number.parseInt(env.MESSAGE_CLASSIFY_BATCH_LIMIT, 10)
          : undefined,
      });

      return {
        scanned: result.scanned,
        classified: result.classified,
        malformed: result.malformed,
        errors: result.errors,
      };
    },
  };
}

/**
 * Application matching. Runs after classification because it links classified
 * messages to attempts; running it first would find nothing to link. Registered
 * as a separate task rather than folded into classification so that one failing
 * cannot stop the other, and so a backlog of unlinked messages can be re-matched
 * without paying for a second classification pass.
 */
function mailboxMatchTask(client: SupabaseClient, env: Record<string, string | undefined>): ScheduledTask {
  return {
    name: MAILBOX_MATCH_TASK_NAME,
    intervalMs: readEnvInt("SCHEDULER_MAILBOX_MATCH_INTERVAL_MS", DEFAULT_MAILBOX_MATCH_INTERVAL_MS, env),
    run: async () => {
      const result = await runApplicationMatchBatch(client, {
        limit: env.MESSAGE_MATCH_BATCH_LIMIT ? Number.parseInt(env.MESSAGE_MATCH_BATCH_LIMIT, 10) : undefined,
      });

      return {
        scanned: result.scanned,
        linked: result.linked,
        review: result.review,
        ambiguous: result.ambiguous,
        unmatched: result.unmatched,
        errors: result.errors,
      };
    },
  };
}

/** Google Calendar sync — interview creation, change, reschedule and cancellation (FR-012). */
function calendarSyncTask(client: SupabaseClient, env: Record<string, string | undefined>): ScheduledTask {
  return {
    name: CALENDAR_SYNC_TASK_NAME,
    intervalMs: readEnvInt("SCHEDULER_CALENDAR_SYNC_INTERVAL_MS", DEFAULT_CALENDAR_SYNC_INTERVAL_MS, env),
    run: async () => {
      const result = await runCalendarSyncBatch(
        client,
        readGoogleOAuthConfig(env),
        readMailboxEncryptionKey(env),
        fetch,
      );

      return {
        connections: result.connections,
        created: result.created,
        rescheduled: result.rescheduled,
        updated: result.updated,
        cancelled: result.cancelled,
        skippedUnlinked: result.skippedUnlinked,
        failures: result.failures,
      };
    },
  };
}

/**
 * Builds the task list. Every task is created here and filtered at the end, so
 * the disabled set can only ever remove a task that exists - a disabled name
 * that matches nothing is silently inert, which is the intended behaviour.
 *
 * TASK ORDER IS EXECUTION ORDER within a tick. Mail poll runs before classify
 * before match, so a message fetched this tick is classified and linked in this
 * same tick instead of waiting a full interval for the next one.
 *
 * GOOGLE-DEPENDENT TASKS ARE OMITTED, NOT FAILED, when their credentials are
 * absent. readMailboxCapability reports why without throwing; the entry point
 * logs that reason once at startup. Classification and matching are deliberately
 * outside that gate because they need no Google access.
 */
export function buildScheduledTasks(
  client: SupabaseClient,
  openai: Pick<OpenAI, "chat">,
  env: Record<string, string | undefined> = process.env,
): ScheduledTask[] {
  const disabled = parseDisabledTasks(env.SCHEDULER_DISABLED_TASKS);
  const capability = readMailboxCapability(env);

  const tasks: ScheduledTask[] = [
    /**
     * THE FIT BACK-FILL. Since the fan-out cap this is load-bearing rather than
     * housekeeping: the DB triggers queue only the NEWEST 200 eligible vacancies per
     * candidate action, so without this task every older vacancy stays unscored for good.
     * It also remains the standing "re-score everything after a scoring-policy bump" tool,
     * because it re-arms rows whose priority_score_version has fallen behind.
     *
     * ENQUEUE-ONLY, which is what makes it safe to schedule: reconcileFitAnalyses touches
     * the database and never the model. It queues; the drain below spends. analyzeFit's
     * AI-skip guard means a pair whose JD snapshot, facts and prompt version are unchanged
     * is re-scored WITHOUT inference, so a version-bump pass costs no tokens and only
     * genuinely missing analyses pay for a call.
     *
     * PLACED FIRST, BEFORE THE DRAIN, for the same reason keyless-ingestion-enqueue sits
     * before ingestion-drain: a tick that reconciles should also collect what it just
     * queued, rather than leaving it a full interval.
     */
    {
      name: FIT_RECONCILE_TASK_NAME,
      intervalMs: readEnvInt(
        "SCHEDULER_FIT_RECONCILE_INTERVAL_MS",
        DEFAULT_FIT_RECONCILE_INTERVAL_MS,
        env,
      ),
      run: async () => {
        // FIT_RECONCILE_LIMIT is the knob npm run worker:fit -- --reconcile already
        // documents; reused rather than shadowed by a second name.
        const result = await reconcileFitAnalyses(client, {
          limit: env.FIT_RECONCILE_LIMIT ? Number.parseInt(env.FIT_RECONCILE_LIMIT, 10) : undefined,
        });

        return { ...result };
      },
    },
    {
      name: FIT_TASK_NAME,
      intervalMs: readEnvInt("SCHEDULER_FIT_INTERVAL_MS", DEFAULT_FIT_INTERVAL_MS, env),
      run: async () => {
        // FIT_ANALYSIS_BATCH_LIMIT is the knob npm run worker:fit already
        // documents; reused rather than shadowed by a second name.
        const maxPerBatch = env.FIT_ANALYSIS_BATCH_LIMIT
          ? Number.parseInt(env.FIT_ANALYSIS_BATCH_LIMIT, 10)
          : undefined;

        const result = await runFitAnalysisBatch(client, { openai }, { maxPerBatch });

        return {
          claimed: result.claimed,
          analyzed: result.analyzed,
          failed: result.failed,
          capped: result.capped,
          noJdText: result.noJdText,
          ...(result.claimError ? { claimError: result.claimError } : {}),
          ...(result.stoppedOnDeadline ? { stoppedOnDeadline: true } : {}),
        };
      },
    },
    /**
     * Batch C ranking refresh. Runs BEFORE the network tasks so the cheap DB work
     * is never delayed by an intake call. It reuses runRankingRefresh exactly, so
     * the scheduled and manual paths cannot diverge; force is always false, so a
     * failed refresh is never auto-retried.
     */
    {
      name: RANKING_REFRESH_TASK_NAME,
      intervalMs: readEnvInt(
        "SCHEDULER_RANKING_REFRESH_INTERVAL_MS",
        DEFAULT_RANKING_REFRESH_INTERVAL_MS,
        env,
      ),
      // Spread into a fresh object so the summary satisfies the scheduler's
      // Record<string, unknown> log payload without an index signature on the type.
      run: async () => ({ ...(await runScheduledRankingRefresh(client, { budget: readScheduledRefreshBudget(env) })) }),
    },
    {
      name: ANTI_GHOSTING_TASK_NAME,
      intervalMs: readEnvInt(
        "SCHEDULER_ANTI_GHOSTING_INTERVAL_MS",
        DEFAULT_ANTI_GHOSTING_INTERVAL_MS,
        env,
      ),
      run: async () => {
        // The 7-day window and the 20-draft cap come from the detector's own
        // exported defaults, not from literals repeated here, so the schedule
        // and the detector cannot disagree about what "ghosted" means.
        const result = await runFollowUpSweep(client, { openai }, {
          minAgeDays: readEnvInt("FOLLOW_UP_MIN_AGE_DAYS", DEFAULT_MIN_AGE_DAYS, env),
          limit: readEnvInt("FOLLOW_UP_SWEEP_LIMIT", DEFAULT_DRAFT_LIMIT, env),
        });

        // The per-attempt reason is carried into the log, not collapsed to a
        // count. The sweep already refuses to throw for one bad draft, which
        // means "failed: 3" is all an operator would otherwise ever see - and the
        // generator's error names the exact fact or paragraph the honesty gate
        // rejected, which is the entire value of having refused instead of sent.
        const failures = result.outcomes
          .filter((outcome) => outcome.outcome === "failed")
          .map((outcome) => ({
            applicationAttemptId: outcome.applicationAttemptId,
            error: outcome.error ?? "unknown",
          }));

        return {
          detected: result.detected,
          drafted: result.drafted,
          failed: result.failed,
          ...(failures.length > 0 ? { failures } : {}),
        };
      },
    },

    /**
     * Step 6 - the SCHEDULED keyless pull. It QUEUES and returns; the drain below
     * processes. Placed immediately before that drain so a target enqueued this tick is
     * fetched in this tick, the same poll-before-classify ordering the mailbox block uses.
     *
     * WHY IT DOES NOT DRAIN. One job is one board, and a real Stripe board took 392s
     * (measured, scripts/discovery-live.ts). A task that both decided what to fetch and
     * fetched it would let one slow board overrun the tick that is supposed to keep the
     * queue full - and it would put a second claimant on the same queue.
     *
     * THE SOURCE LIST IS THE QUOTA GUARD. Only the keyless public APIs are named, and the
     * filter is fail-safe: an empty allow-list enqueues nothing rather than everything, so
     * a miscomputed list cannot put Jooble's lifetime 500-request allowance on a path
     * nobody is watching. A keyless source with no enabled vacancy_sources row is simply
     * not polled - there is no target to poll.
     */
    {
      name: KEYLESS_INGESTION_ENQUEUE_TASK_NAME,
      intervalMs: readEnvInt(
        "SCHEDULER_KEYLESS_INGESTION_INTERVAL_MS",
        DEFAULT_KEYLESS_INGESTION_INTERVAL_MS,
        env,
      ),
      run: async () =>
        ({ ...(await enqueueIngestionBatch(client, { sourceCodes: KEYLESS_SCHEDULED_SOURCE_CODES })) }),
    },

    /**
     * Ingestion drain. Placed before the mailbox block rather than after, because every
     * task in this array shares the tick: a drain that overruns its deadline delays
     * everything behind it, and mailbox classification is what the candidate notices.
     *
     * It QUEUES NOTHING. Whatever the button enqueued, or the keyless pull above
     * enqueues, is what gets drained - so this task can be enabled, disabled or reordered
     * without changing what the feed contains.
     */
    {
      name: INGESTION_DRAIN_TASK_NAME,
      intervalMs: readEnvInt("SCHEDULER_INGESTION_DRAIN_INTERVAL_MS", DEFAULT_INGESTION_DRAIN_INTERVAL_MS, env),
      run: async () => {
        const result = await drainIngestionJobs(client, {
          maxJobs: readEnvInt("SCHEDULER_INGESTION_DRAIN_MAX_JOBS", DEFAULT_INGESTION_DRAIN_MAX_JOBS, env),
          deadlineMs: readEnvInt("SCHEDULER_INGESTION_DRAIN_DEADLINE_MS", DEFAULT_INGESTION_DRAIN_DEADLINE_MS, env),
        });
        return { ...result };
      },
    },

    // Mailbox and calendar. Poll runs before classify before match, so a message
    // fetched in this tick is classified and linked in this tick.
    ...(capability.googleMail.enabled ? [mailboxPollTask(client, openai, env)] : []),
    mailboxClassifyTask(client, openai, env),
    mailboxMatchTask(client, env),
    ...(capability.googleCalendar.enabled ? [calendarSyncTask(client, env)] : []),

    /**
     * The candidate-triggered intake refresh drain. Placed AFTER the mailbox block: it is
     * the heaviest network task in the array (a multi-source fan-out plus a bounded fit
     * batch), so putting it ahead of mail classification would let it delay the messages a
     * candidate actually notices.
     *
     * It carries the OpenAI client because scoring the vacancies a refresh just created
     * moved here with the fan-out. Fetching without scoring leaves the new jobs ranked
     * below everything else, which is the defect this whole path exists to remove.
     */
    {
      name: INTAKE_REFRESH_DRAIN_TASK_NAME,
      intervalMs: readEnvInt(
        "SCHEDULER_INTAKE_REFRESH_INTERVAL_MS",
        DEFAULT_INTAKE_REFRESH_DRAIN_INTERVAL_MS,
        env,
      ),
      run: async () => {
        const result = await drainIntakeRefreshJobs(client, {
          deps: { openai },
          // Unset leaves the drain's own defaults (3 jobs; a lease-safe 4-minute budget).
          ...(env.SCHEDULER_INTAKE_REFRESH_MAX_JOBS
            ? { maxJobs: Number.parseInt(env.SCHEDULER_INTAKE_REFRESH_MAX_JOBS, 10) }
            : {}),
          ...(env.SCHEDULER_INTAKE_REFRESH_DEADLINE_MS
            ? { deadlineMs: Number.parseInt(env.SCHEDULER_INTAKE_REFRESH_DEADLINE_MS, 10) }
            : {}),
        });
        return { ...result };
      },
    },

  ];

  return tasks.filter((task) => !disabled.has(task.name));
}
