import type { SupabaseClient } from "@supabase/supabase-js";
import { ACCEPTANCE_EVIDENCE_TYPE, isTrustworthyAcceptanceEvidence } from "../../shared/pipelineStages.js";

/**
 * Executable reconciliation for accepted-but-unrecorded submissions.
 *
 * WHAT PROBLEM THIS SOLVES. worker.ts crosses a durable submission boundary and
 * then writes the receipt followed by the final status. If either write fails,
 * the attempt stays 'submitting': an external application may have been
 * accepted, but nothing durable says so, and the claim predicate deliberately
 * cannot reclaim it. Without this, such a row is stuck forever with no
 * supported way to finish it.
 *
 * WHAT IT ABSOLUTELY DOES NOT DO. It never imports, resolves or calls a
 * submission adapter, never submits externally, never creates an attempt and
 * never returns a row to the ordinary retry queue. Reconciliation is a LOCAL
 * bookkeeping repair of work that already happened; the only external effect it
 * could have is none at all. That is enforced structurally: this module has no
 * adapter import and no network call.
 *
 * IT CANNOT INVENT ACCEPTANCE. A row is only finalized when a trustworthy
 * confirmation (shared isTrustworthyAcceptanceEvidence — the same contract the
 * feed, Applications and MCP classify with) is persisted AGAINST THAT ATTEMPT.
 * An attempt whose evidence is missing, malformed, or belongs to a different
 * attempt stays unresolved, and is reported as such rather than guessed at.
 *
 * IDEMPOTENT AND CONCURRENCY-SAFE. The update is conditional on the status it
 * read ('submitting'), so a concurrent writer that already finalized — or
 * cancelled — the attempt makes the update match zero rows, and that is
 * reported as skipped rather than as success. Running it twice is harmless.
 */

/** The statuses reconciliation may act on. Anything else is left alone deliberately. */
export const RECOVERABLE_ATTEMPT_STATUS = "submitting";

/** Terminal or in-flight states a concurrent writer may have set. Reported, never overwritten. */
export const UNTOUCHED_STATUSES = ["succeeded", "failed", "cancelled", "action_required", "leased", "pending", "pending_review"];

export interface EvidenceRecoveryOptions {
  /** Report what would change without writing anything. */
  dryRun?: boolean;
  /** Bounded processing: at most this many attempts are considered per run. */
  limit?: number;
}

export interface EvidenceRecoveryOutcome {
  applicationAttemptId: string;
  outcome: "finalized" | "would_finalize" | "skipped";
  /** Why it was skipped, or the evidence timestamp used for succeeded_at. */
  detail?: string;
}

export interface EvidenceRecoveryResult {
  dryRun: boolean;
  considered: number;
  finalized: number;
  skipped: number;
  outcomes: EvidenceRecoveryOutcome[];
}

export const DEFAULT_RECOVERY_LIMIT = 50;

interface AttemptRow {
  id: string;
  status: string;
}

interface EvidenceRow {
  application_attempt_id: string;
  evidence_type: string;
  payload: unknown;
  captured_at: string | null;
}

/**
 * Finalizes attempts that already have a trustworthy confirmation.
 *
 * ERRORS ARE EXPLICIT: any read or write error throws. A swallowed error here
 * would report "nothing to reconcile" while rows stayed stuck, which is the
 * failure mode this exists to remove.
 */
export async function recoverAcceptedAttempts(
  client: Pick<SupabaseClient, "from">,
  options: EvidenceRecoveryOptions = {},
): Promise<EvidenceRecoveryResult> {
  const dryRun = options.dryRun === true;
  const limit = options.limit ?? DEFAULT_RECOVERY_LIMIT;

  const { data: attemptData, error: attemptError } = await client
    .from("application_attempts")
    .select("id, status")
    .eq("status", RECOVERABLE_ATTEMPT_STATUS)
    .order("submission_started_at", { ascending: true })
    .limit(limit);

  if (attemptError) {
    throw attemptError;
  }

  const attempts = (attemptData ?? []) as AttemptRow[];
  const result: EvidenceRecoveryResult = {
    dryRun,
    considered: attempts.length,
    finalized: 0,
    skipped: 0,
    outcomes: [],
  };

  if (attempts.length === 0) {
    return result;
  }

  const { data: evidenceData, error: evidenceError } = await client
    .from("application_evidence")
    .select("application_attempt_id, evidence_type, payload, captured_at")
    .in("application_attempt_id", attempts.map((attempt) => attempt.id));

  if (evidenceError) {
    throw evidenceError;
  }

  // One trustworthy confirmation per attempt. The FIRST captured row wins, so
  // the authoritative acceptance time is stable across repeated runs.
  const confirmationByAttempt = new Map<string, EvidenceRow>();

  for (const row of (evidenceData ?? []) as EvidenceRow[]) {
    if (!isTrustworthyAcceptanceEvidence(row)) {
      continue;
    }

    const existing = confirmationByAttempt.get(row.application_attempt_id);

    if (existing === undefined) {
      confirmationByAttempt.set(row.application_attempt_id, row);
      continue;
    }

    const existingAt = existing.captured_at ?? "";
    const candidateAt = row.captured_at ?? "";

    if (candidateAt !== "" && (existingAt === "" || candidateAt < existingAt)) {
      confirmationByAttempt.set(row.application_attempt_id, row);
    }
  }

  for (const attempt of attempts) {
    const confirmation = confirmationByAttempt.get(attempt.id);

    if (confirmation === undefined) {
      result.skipped += 1;
      result.outcomes.push({
        applicationAttemptId: attempt.id,
        outcome: "skipped",
        detail: "No trustworthy confirmation stored for this attempt; outcome remains unverified.",
      });
      continue;
    }

    if (dryRun) {
      result.finalized += 1;
      result.outcomes.push({
        applicationAttemptId: attempt.id,
        outcome: "would_finalize",
        detail:
          confirmation.captured_at === null
            ? "evidence capture time unavailable"
            : "evidence captured " + confirmation.captured_at,
      });
      continue;
    }

    // TIMESTAMP SEMANTICS, STATED HONESTLY. application_evidence.captured_at is
    // a DATABASE insertion default (now()), not a provider-reported acceptance
    // time: ApplicationSubmissionResult carries { evidenceType, payload } and no
    // acceptance timestamp, so no contract establishes an external one. What
    // captured_at IS is the earliest moment we can prove the receipt existed,
    // which is the closest available record of when the submission completed.
    // succeeded_at therefore takes that value — deliberately NOT the
    // reconciliation time, so a repair does not rewrite the submission date with
    // today's clock — and the reconciliation moment goes to updated_at. Neither
    // value is presented as a provider-reported acceptance time.
    const update: Record<string, unknown> = {
      status: "succeeded",
      updated_at: new Date().toISOString(),
    };

    if (confirmation.captured_at !== null) {
      update.succeeded_at = confirmation.captured_at;
    }

    // CONDITIONAL: only the status this run actually read. A concurrent writer
    // that finalized or cancelled the attempt makes this match zero rows, and
    // that is reported as skipped rather than overwritten.
    const { data: updated, error: updateError } = await client
      .from("application_attempts")
      .update(update)
      .eq("id", attempt.id)
      .eq("status", RECOVERABLE_ATTEMPT_STATUS)
      .select("id");

    if (updateError) {
      throw updateError;
    }

    if (!Array.isArray(updated) || updated.length !== 1) {
      result.skipped += 1;
      result.outcomes.push({
        applicationAttemptId: attempt.id,
        outcome: "skipped",
        detail: "Status changed while reconciling; left untouched.",
      });
      continue;
    }

    result.finalized += 1;
    result.outcomes.push({
      applicationAttemptId: attempt.id,
      outcome: "finalized",
      detail:
        confirmation.captured_at === null
          ? "evidence capture time unavailable"
          : "evidence captured " + confirmation.captured_at,
    });
  }

  return result;
}

/** Reads the terminal statuses this module deliberately does not touch, for operator output. */
export function untouchedStatuses(): readonly string[] {
  return UNTOUCHED_STATUSES;
}

export { ACCEPTANCE_EVIDENCE_TYPE };
