import type { SupabaseClient } from "@supabase/supabase-js";
import { AtsSubmissionError } from "./adapters/errors.js";
import { createActionRequiredEvent } from "./actionRequired.js";
import { isVacancyDismissed } from "./dismissalGate.js";
import { ACCEPTANCE_EVIDENCE_TYPE } from "../../shared/pipelineStages.js";
import {
  ActionRequiredSubmissionError,
  AuthorizationWithdrawnError,
  submitApplicationAttempt,
} from "./submissionAdapter.js";

export interface RunOneAttemptResult {
  processed: boolean;
  applicationAttemptId?: string;
  outcome?: "succeeded" | "failed" | "action_required" | "cancelled" | "needs_verification";
  error?: string;
}

interface ClaimedAttempt {
  id: string;
  application_plan_id: string;
  attempts: number;
  max_attempts: number;
  /**
   * The fencing token minted by claim_application_attempt() for THIS worker.
   * Null against a database that has not run
   * 20261001160000_application_submission_fencing.sql; the boundary then
   * refuses to cross, which is the safe direction.
   */
  lease_token: string | null;
}

/**
 * Claims and executes exactly one application_attempts row. Structurally
 * mirrors runOneIngestionJob (server/ingestion/worker.ts) — same claim-
 * RPC-then-try/catch shape, same exponential-backoff-vs-dead-letter
 * decision — reusing the proven pattern instead of inventing a second one
 * for this queue. Like that function, this doesn't run a persistent
 * process itself; a caller loops on this or schedules it periodically.
 *
 * submitApplicationAttempt (R7-M2) resolves a real per-source adapter, but
 * every source_code still resolves to unsupportedAdapter today (see
 * server/applications/adapters/registry.ts — no real per-source case
 * exists yet), which throws a plain Error. So in practice every real call
 * currently takes the generic catch branch below and records a
 * 'failed'/retry outcome, never the action_required one — no adapter
 * exists yet that could throw ActionRequiredSubmissionError instead. The
 * success, action_required, and cancelled (R7-M4) branches all exist and
 * are evidence-tested so their recording logic is proven correct ahead of
 * the first real adapter landing, not exercised by a fake happy path in
 * production.
 */
export async function runOneApplicationAttempt(client: SupabaseClient): Promise<RunOneAttemptResult> {
  const { data: attempts, error: claimError } = await client.rpc("claim_application_attempt");

  if (claimError) {
    throw claimError;
  }

  const attempt = attempts?.[0] as ClaimedAttempt | undefined;

  if (!attempt) {
    return { processed: false };
  }

  // DISMISSAL RECHECK, IMMEDIATELY BEFORE SUBMISSION. The queue-time gate ran
  // when the plan was created; this is the second check, at the last moment
  // before anything leaves the building, because a candidate can dismiss a job
  // while an attempt is already leased. Cancelled rather than failed: nothing
  // was attempted at the portal, so there is no submission to retry and the row
  // (and its history) is left intact.
  //
  // candidate_id/vacancy_id live on the PLAN, not on the attempt, so this is a
  // second read rather than an attempt column. A missing plan row leaves the
  // recheck unperformed; the queue-time gate remains the primary enforcement and
  // such an attempt could not submit anyway.
  const { data: plan, error: planError } = await client
    .from("application_plans")
    .select("candidate_id, vacancy_id")
    .eq("id", attempt.application_plan_id)
    .maybeSingle();

  if (planError) {
    throw planError;
  }

  const planRow = plan as { candidate_id: string; vacancy_id: string } | null;

  if (planRow !== null && (await isVacancyDismissed(client, planRow.candidate_id, planRow.vacancy_id))) {
    await client
      .from("application_attempts")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", attempt.id);

    return { processed: true, applicationAttemptId: attempt.id, outcome: "cancelled" };
  }

  // THE SUBMISSION BOUNDARY, CROSSED BEFORE THE ADAPTER IS CALLED.
  //
  // Why it must come first: claim_application_attempt reclaims
  // (status = 'pending') OR (status = 'leased' AND leased_until < now()). An
  // attempt left 'leased' after an accepted submission is therefore reclaimed
  // five minutes later and submitted again. Writing a marker AFTER the adapter
  // returns cannot close that — if the marker write is what fails, the row is
  // still reclaimable. 'submitting' is absent from the claim predicate, so
  // crossing this boundary once is what makes resubmission impossible.
  //
  // The WHERE clause is the ownership and expiry check, evaluated atomically
  // with the transition: a stale worker whose lease has already expired, or one
  // racing a reclaim, matches zero rows and MUST NOT call the adapter. The
  // PostgREST error is checked too — an awaited builder resolves with { error }
  // rather than throwing, so an unchecked write would look like success.
  // FENCING + DATABASE-TIME EXPIRY, IN ONE ATOMIC STATEMENT.
  //
  // "status = 'leased' and leased_until in the future" is not proof that THIS
  // worker holds the lease: a worker whose lease expired and whose row was then
  // re-leased satisfies both. begin_application_submission additionally requires
  // the lease_token minted for this worker, and evaluates leased_until against
  // now() INSIDE the database, so the worker's own clock cannot be the thing
  // that grants it permission.
  const boundary = await client.rpc("begin_application_submission", {
    p_attempt_id: attempt.id,
    p_lease_token: attempt.lease_token,
  });

  if (boundary.error) {
    // Includes the schema-not-migrated case, where the function does not exist.
    // Fatal on purpose: a boundary that cannot be established means the adapter
    // must not be called, and failing loudly beats submitting unprotected.
    throw boundary.error;
  }

  if (boundary.data !== true) {
    // Lost the lease to another worker, never legitimately held it, or the
    // lease expired. Nothing has been sent anywhere, so this is not an
    // uncertain outcome.
    return { processed: true, applicationAttemptId: attempt.id, outcome: "cancelled" };
  }

  try {
    const result = await submitApplicationAttempt(client, {
      applicationAttemptId: attempt.id,
      applicationPlanId: attempt.application_plan_id,
    });

    // EVIDENCE FIRST, AND ITS ERROR CHECKED. The receipt is what makes
    // "Applied" true; the status is an index into it. Writing the status first
    // and hoping the evidence follows is exactly how a bare 'succeeded' row —
    // and therefore a false Applied — was produced before.
    // THE CANONICAL ACCEPTANCE RECORD. The adapter's own evidenceType is
    // adapter-chosen (ApplicationSubmissionResult leaves it to the adapter), so
    // it cannot be what a reader keys on: a second adapter returning
    // "confirmation_id" would silently stop counting as acceptance. The worker
    // writes ONE canonical type — the same constant the reader uses — and keeps
    // the adapter's own type and payload inside it as provenance.
    // THE ADAPTER'S OWN CLAIM IS CHECKED BEFORE IT IS CANONICALIZED. Returning
    // from submit() means the adapter reports success, but an adapter that
    // returns an empty or non-object payload has confirmed nothing; writing the
    // canonical acceptance type around it would turn "success" into evidence.
    // This does not require a portal receipt field — it requires the adapter to
    // have said SOMETHING, which is the minimum the existing contract allows us
    // to verify.
    const adapterPayload = result.payload;
    const adapterPayloadIsConfirming =
      typeof adapterPayload === "object" &&
      adapterPayload !== null &&
      !Array.isArray(adapterPayload) &&
      Object.keys(adapterPayload).length > 0;

    if (typeof result.evidenceType !== "string" || result.evidenceType.trim() === "" || !adapterPayloadIsConfirming) {
      // Accepted in the adapter's view, but nothing durable proves it. Same
      // terminal state as a failed receipt write: the attempt stays 'submitting'
      // and no automatic resubmission is possible.
      return { processed: true, applicationAttemptId: attempt.id, outcome: "needs_verification" };
    }

    const evidenceInsert = await client.from("application_evidence").insert({
      application_attempt_id: attempt.id,
      evidence_type: ACCEPTANCE_EVIDENCE_TYPE,
      payload: { adapterEvidenceType: result.evidenceType, ...result.payload },
    });

    if (evidenceInsert.error) {
      // The portal accepted it, so this outcome is CONFIRMED — but we hold no
      // receipt. The attempt stays 'submitting', which the claim predicate
      // cannot reclaim, so there is no automatic resubmission. It is reported
      // as needing verification rather than failed: it was not a failure.
      return { processed: true, applicationAttemptId: attempt.id, outcome: "needs_verification" };
    }

    // succeeded_at is written HERE, on the transition, and nowhere else. It is
    // the timestamp the anti-ghosting detector measures from, and it exists
    // because updated_at cannot serve: that column means "last modified" and
    // moves for unrelated writes (generating a cover letter touches the row).
    // A seven-day clock keyed on a column that other code rewrites would reset
    // silently and the application would never be flagged.
    const succeededAt = new Date().toISOString();

    const statusUpdate = await client
      .from("application_attempts")
      .update({ status: "succeeded", succeeded_at: succeededAt, updated_at: succeededAt })
      .eq("id", attempt.id);

    if (statusUpdate.error) {
      // The receipt IS stored, so recovery can finish this without the adapter:
      // see the migration's recovery query. Reported as needing verification
      // rather than succeeded, because this function cannot claim a status it
      // did not manage to write.
      return { processed: true, applicationAttemptId: attempt.id, outcome: "needs_verification" };
    }

    return { processed: true, applicationAttemptId: attempt.id, outcome: "succeeded" };
  } catch (error) {
    if (error instanceof AuthorizationWithdrawnError) {
      // R7-M4: no application_evidence is written — nothing happened at
      // the adapter/portal level to have evidence about, this is purely
      // an internal authorization-gate decision. attempts is deliberately
      // left untouched (no compensating decrement): claim_application_attempt
      // already incremented it for this claim, and undoing that would be
      // a new kind of mutation with no precedent elsewhere in this
      // codebase. The common case — a candidate paused/stopped before
      // this claim happened at all — never reaches here in the first
      // place, because the same migration's cancellation sweep cancels
      // those rows before they're ever leased, so attempts is never
      // incremented for them to begin with.
      await client
        .from("application_attempts")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", attempt.id);

      return { processed: true, applicationAttemptId: attempt.id, outcome: "cancelled" };
    }

    if (error instanceof ActionRequiredSubmissionError) {
      await client.from("application_evidence").insert({
        application_attempt_id: attempt.id,
        evidence_type: "action_required",
        payload: { exceptionType: error.exceptionType, ...error.payload },
      });

      await createActionRequiredEvent(client, {
        applicationAttemptId: attempt.id,
        exceptionType: error.exceptionType,
        payload: error.payload,
        expiresAt: error.expiresAt,
      });

      return { processed: true, applicationAttemptId: attempt.id, outcome: "action_required" };
    }

    const message = error instanceof Error ? error.message : String(error);

    // Task H3, PRD §16.2 "handles validation/rate limits". ONLY an error the
    // adapter classified as an ATS outcome tells us what the portal did; the
    // retryability decision now happens after the unknown-outcome branch below.
    const atsError = error instanceof AtsSubmissionError ? error : null;

    const errorEvidence = await client.from("application_evidence").insert({
      application_attempt_id: attempt.id,
      evidence_type: "submission_error",
      payload: {
        message,
        ...(atsError
          ? {
              reasonCode: atsError.reasonCode,
              httpStatus: atsError.status,
              retryable: atsError.retryable,
              retryAfterSeconds: atsError.retryAfterSeconds,
            }
          : {}),
      },
    });

    // AN UNCLASSIFIED ERROR IS AN UNKNOWN EXTERNAL OUTCOME, NOT A FAILURE.
    //
    // Only the adapter can tell us that the portal did not accept the
    // submission (AtsSubmissionError). Anything else — a socket timeout, a
    // connection reset mid-request — may have been accepted on the other side.
    // This repository holds no provider idempotency key, so retrying would risk
    // a second real application. The attempt therefore STAYS 'submitting', which
    // claim_application_attempt cannot reclaim, and is surfaced for verification
    // instead of being returned to the ordinary retry queue.
    //
    // The status is deliberately not written here: leaving it untouched is what
    // keeps the row out of the queue.
    if (atsError === null) {
      const note = errorEvidence.error
        ? message + " (submission_error evidence could not be recorded)"
        : message;

      const unknownUpdate = await client
        .from("application_attempts")
        .update({ last_error: note, updated_at: new Date().toISOString() })
        .eq("id", attempt.id);

      if (unknownUpdate.error) {
        throw unknownUpdate.error;
      }

      return { processed: true, applicationAttemptId: attempt.id, outcome: "needs_verification" };
    }

    // From here the provider itself classified the outcome, so the existing
    // policy applies unchanged: a validation rejection is terminal on the FIRST
    // attempt, and a provider-classified transient failure is safe to retry
    // because the provider told us it did NOT accept the submission.
    // RETRY ONLY WHEN THE ADAPTER HAS ESTABLISHED NON-ACCEPTANCE.
    //
    // The error class proves nothing: an ATS error can be raised after the
    // request reached the portal. 'retryable' means "another attempt might
    // succeed", NOT "nothing was accepted", so on its own it is not a licence to
    // resubmit — no provider idempotency key exists here, and a duplicate
    // application is worse than a delayed one. Without that establishment the
    // attempt keeps the boundary state and is surfaced for verification.
    if (!atsError.nonAcceptanceEstablished) {
      const unknownUpdate = await client
        .from("application_attempts")
        .update({ last_error: message, updated_at: new Date().toISOString() })
        .eq("id", attempt.id);

      if (unknownUpdate.error) {
        throw unknownUpdate.error;
      }

      return { processed: true, applicationAttemptId: attempt.id, outcome: "needs_verification" };
    }

    const retryable = atsError.retryable;

    // A validation rejection is terminal on the FIRST attempt, not after
    // max_attempts. The employer's form refused what we sent and will refuse it
    // again; retrying four times by exponential backoff burns that employer's
    // API budget and delays telling the candidate their application needs
    // attention. This is the "validation" half of §16.2.
    const exhausted = attempt.attempts >= attempt.max_attempts || !retryable;

    if (exhausted) {
      // Dead-letter: claim_application_attempt's WHERE clause never
      // matches 'failed', so this is terminal — visible via
      // application_evidence and this row for manual review.
      await client
        .from("application_attempts")
        .update({ status: "failed", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", attempt.id);
    } else {
      // Retry with backoff: setting status back to 'pending' would make
      // it immediately reclaimable (claim_application_attempt's WHERE
      // doesn't check leased_until for 'pending' rows) — staying
      // 'leased' with a future leased_until is what actually delays the
      // retry. Same backoff formula as runOneIngestionJob.
      // The provider's Retry-After wins when it is longer than our own backoff —
      // it is the party that knows when it will accept requests again. Ignoring
      // it would mean hammering a rate-limited endpoint on a schedule we chose
      // rather than the one we were asked to keep.
      const exponentialMinutes = Math.min(2 ** attempt.attempts, 60);
      const providerMinutes = atsError?.retryAfterSeconds != null ? atsError.retryAfterSeconds / 60 : 0;
      const backoffMinutes = Math.max(exponentialMinutes, providerMinutes);
      await client
        .from("application_attempts")
        .update({
          status: "leased",
          leased_until: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", attempt.id);
    }

    return { processed: true, applicationAttemptId: attempt.id, outcome: "failed", error: message };
  }
}
