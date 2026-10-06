import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { runFitAnalysisBatch } from "./opportunities/runner.js";
import {
  readScheduledRefreshBudget,
  runScheduledDiscovery,
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
 * No ingestion and no mailbox polling. Both reach the network and need
 * credentials this scheduler does not have to own, and neither was asked for.
 * Adding a task here is one entry in the array below, so the decision stays
 * cheap to revisit - but it is a decision, not a default.
 *
 * Both tasks that ARE here are drains of a queue that something else fills, and
 * both are idempotent: fit_analysis_jobs is leased with FOR UPDATE SKIP LOCKED,
 * and the ghosting detector excludes attempts that already have a draft. Running
 * them more often than intended cannot double-apply anything.
 */

/** The brief's cadence: drain pending fit analysis every five minutes. */
export const DEFAULT_FIT_INTERVAL_MS = 5 * 60_000;

/**
 * The brief allows 12 or 24 hours; 24 is the default because the detector's own
 * window is 7 days. A sweep every 12 hours would re-ask a question whose answer
 * cannot have changed for at least a day, and the "already drafted" exclusion
 * means the second run of any day is guaranteed to find nothing new. Twelve
 * hours is one environment variable away (SCHEDULER_ANTI_GHOSTING_INTERVAL_MS).
 */
export const DEFAULT_ANTI_GHOSTING_INTERVAL_MS = 24 * 60 * 60_000;

export const FIT_TASK_NAME = "fit-analysis";
export const RANKING_REFRESH_TASK_NAME = "ranking-refresh";
export const DISCOVERY_TASK_NAME = "discovery";
export const ANTI_GHOSTING_TASK_NAME = "anti-ghosting";
export const MAILBOX_POLL_TASK_NAME = "mailbox-poll";
export const MAILBOX_CLASSIFY_TASK_NAME = "mailbox-classify";
export const MAILBOX_MATCH_TASK_NAME = "mailbox-match";
export const CALENDAR_SYNC_TASK_NAME = "calendar-sync";

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
 * Batch C — scheduled discovery. It reaches third-party APIs, so it defaults
 * CONSERVATIVELY to four runs a day even though the unattended path is restricted
 * to keyless public sources; SCHEDULER_DISCOVERY_INTERVAL_MS changes it without a
 * deploy, and each tick is capped to SCHEDULER_REFRESH_MAX_CANDIDATES_PER_TICK.
 */
export const DEFAULT_DISCOVERY_INTERVAL_MS = 6 * 60 * 60_000;

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

    // Mailbox and calendar. Poll runs before classify before match, so a message
    // fetched in this tick is classified and linked in this tick.
    ...(capability.googleMail.enabled ? [mailboxPollTask(client, openai, env)] : []),
    mailboxClassifyTask(client, openai, env),
    mailboxMatchTask(client, env),
    ...(capability.googleCalendar.enabled ? [calendarSyncTask(client, env)] : []),

    /**
     * Batch C scheduled discovery. LAST so its network latency never delays the
     * DB tasks; authorization and keyless-only source selection live inside the
     * task, and new vacancies are ranked by the next ranking-refresh tick.
     */
    {
      name: DISCOVERY_TASK_NAME,
      intervalMs: readEnvInt("SCHEDULER_DISCOVERY_INTERVAL_MS", DEFAULT_DISCOVERY_INTERVAL_MS, env),
      run: async () => ({ ...(await runScheduledDiscovery(client, { budget: readScheduledRefreshBudget(env) })) }),
    },
  ];

  return tasks.filter((task) => !disabled.has(task.name));
}
