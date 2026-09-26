import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { runIngestionBatch } from "../ingestion/runner.js";
import { runFitAnalysisBatch } from "../opportunities/runner.js";
import { runMessageClassificationBatch } from "../mailbox/classifyBatch.js";
import { runApplicationMatchBatch } from "../mailbox/matchBatch.js";
import { runFollowUpSweep } from "../mailbox/antiGhosting.js";
import { runMailboxPollingBatch } from "../mailbox/poll.js";
import { runCalendarSyncBatch } from "../calendar/sync.js";
import type { GoogleOAuthConfig } from "../mailbox/oauth.js";

/**
 * The worker batches an admin may trigger from the console.
 *
 * WHY THIS EXISTS AT ALL. The /api/worker/* routes are authenticated by
 * WORKER_TRIGGER_SECRET, which a browser cannot hold and must not: putting it
 * there would hand every admin session the same credential an external cron
 * uses, and a leaked session would then be able to drive the scheduler. These
 * run the same functions behind a session plus requireAdmin instead, so no
 * shared secret ever reaches the client.
 *
 * WHAT IS DELIBERATELY ABSENT, and this is the important part of the list.
 *
 *   applications — runApplicationBatch dispatches real submissions. The
 *   review-before-submit gate means it cannot claim an attempt a candidate asked
 *   to review (claim_application_attempt is an allowlist on 'pending'), but for
 *   every candidate who did not ask, it submits. That belongs behind its own
 *   explicit trigger, not as one button among eight in an ops console.
 *
 *   registry-lookup — runOneRegistryLookupJob needs MCA credentials
 *   (apiKey + resourceId) that no deployment has yet and no environment
 *   variable provides. Offering the button would be a 503 dressed as a feature.
 *
 * BOUNDS ARE SERVER-DECIDED. Every task runs with its own runner's default cap;
 * no limit is accepted from the request, because a UI bug or a curious operator
 * should not be able to widen a batch. The per-admin rate limit on the route is
 * the other half of that bound.
 */

export type AdminWorkerTaskName =
  | "ingestion"
  | "fit-analysis"
  | "classify-messages"
  | "match-messages"
  | "anti-ghosting"
  | "mailbox-poll"
  | "calendar-sync";

export const ADMIN_WORKER_TASKS: readonly AdminWorkerTaskName[] = [
  "ingestion",
  "fit-analysis",
  "classify-messages",
  "match-messages",
  "anti-ghosting",
  "mailbox-poll",
  "calendar-sync",
];

export function isAdminWorkerTask(value: unknown): value is AdminWorkerTaskName {
  return typeof value === "string" && (ADMIN_WORKER_TASKS as readonly string[]).includes(value);
}

/**
 * A task whose credentials or configuration are absent on this deployment.
 * The route answers 503 with this message, matching the ATS-credential route:
 * the name of the unset variable is the actionable part.
 */
export class WorkerTaskNotConfiguredError extends Error {
  constructor(task: AdminWorkerTaskName, detail: string) {
    super('The "' + task + '" task is not configured on this deployment: ' + detail);
    this.name = "WorkerTaskNotConfiguredError";
  }
}

/**
 * Resolved lazily on purpose. Resolving everything up front would make a missing
 * OPENAI_API_KEY break ingestion and match-messages, which need no model at all,
 * and a missing Google credential break all seven.
 */
export interface AdminWorkerTaskDeps {
  openai: () => Pick<OpenAI, "chat">;
  googleOAuthConfig: () => GoogleOAuthConfig;
  mailboxEncryptionKey: () => Buffer;
}

/** Turns a credential-reader throw into the 503-shaped error, naming the task. */
function require<T>(task: AdminWorkerTaskName, resolve: () => T): T {
  try {
    return resolve();
  } catch (error) {
    throw new WorkerTaskNotConfiguredError(task, error instanceof Error ? error.message : String(error));
  }
}

export async function runAdminWorkerTask(
  client: SupabaseClient,
  task: AdminWorkerTaskName,
  deps: AdminWorkerTaskDeps,
): Promise<Record<string, unknown>> {
  switch (task) {
    case "match-messages": {
      // Cheapest and safest: pure linking, no model call.
      const result = await runApplicationMatchBatch(client);
      return {
        scanned: result.scanned,
        linked: result.linked,
        review: result.review,
        ambiguous: result.ambiguous,
        unmatched: result.unmatched,
        errors: result.errors,
      };
    }

    case "classify-messages": {
      const result = await runMessageClassificationBatch(client, require(task, deps.openai));
      return {
        scanned: result.scanned,
        classified: result.classified,
        malformed: result.malformed,
        errors: result.errors,
      };
    }

    case "fit-analysis": {
      const result = await runFitAnalysisBatch(client, { openai: require(task, deps.openai) });
      return {
        claimed: result.claimed,
        analyzed: result.analyzed,
        capped: result.capped,
        noJdText: result.noJdText,
        failed: result.failed,
      };
    }

    case "ingestion": {
      const result = await runIngestionBatch(client);
      return {
        targets: result.targets.length,
        vacanciesFetched: result.vacanciesFetched,
        failed: result.failed,
        skippedRecent: result.skippedRecent,
        skippedQueued: result.skippedQueued,
      };
    }

    case "anti-ghosting": {
      const result = await runFollowUpSweep(client, { openai: require(task, deps.openai) });
      return { detected: result.detected, drafted: result.drafted, failed: result.failed };
    }

    case "mailbox-poll": {
      const result = await runMailboxPollingBatch(
        client,
        require(task, deps.googleOAuthConfig),
        require(task, deps.mailboxEncryptionKey),
        fetch,
        require(task, deps.openai),
      );
      return {
        claimed: result.claimed,
        succeeded: result.succeeded,
        transientErrors: result.transientErrors,
        terminalErrors: result.terminalErrors,
      };
    }

    case "calendar-sync": {
      const result = await runCalendarSyncBatch(
        client,
        require(task, deps.googleOAuthConfig),
        require(task, deps.mailboxEncryptionKey),
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
    }

    default: {
      // Exhaustive: adding a name to the union without a branch here is a
      // compile error rather than a silently unhandled request.
      const unhandled: never = task;
      throw new Error("Unhandled worker task: " + String(unhandled));
    }
  }
}
