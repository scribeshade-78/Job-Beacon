import type { SupabaseClient } from "@supabase/supabase-js";
import { ACCEPTANCE_EVIDENCE_TYPE } from "../../shared/pipelineStages.js";

/**
 * How an extension-reported submission is recorded, and where each report lands.
 *
 * THE EXTENSION IS NOT AN ADAPTER. The adapter path trusts submit() because an adapter is
 * server-side code we wrote, running against the portal itself. The extension runs on the
 * candidate's machine and is theirs to modify, so its "success" is a CLAIM BY A
 * USER-CONTROLLED PROGRAM - not evidence. Applying the adapter path's confirming rule one
 * layer out is what keeps "succeeded" meaning something.
 *
 * WHY THIS MATTERS BEYOND TIDINESS: succeeded_at starts the anti-ghosting clock. An
 * attempt marked succeeded on a bare claim would begin a seven-day countdown against an
 * application that may never have been sent, and the candidate would stop following up on
 * a job they never applied to. That is the one failure that does not merely fail - it
 * misinforms.
 *
 * FOUR OUTCOMES, AND ONLY FOUR. A client reports succeeded or failed; everything else is a
 * 400. There is no third state for a client to invent, and no status it can write directly.
 */

export type ReportedOutcome = "succeeded" | "failed";

/** What the extension scraped from the page, if anything. */
export interface OutcomeEvidence {
  confirmationUrl?: string;
  confirmationText?: string;
  referenceId?: string;
}

export interface ReportOutcomeInput {
  candidateId: string;
  attemptId: string;
  leaseToken: string;
  outcome: ReportedOutcome;
  evidence?: OutcomeEvidence | null;
  error?: { message: string; reasonCode?: string; retryable?: boolean } | null;
  now?: () => Date;
}

export type ReportOutcomeResult =
  | { accepted: true; finalStatus: "succeeded" | "needs_verification" | "failed" }
  | {
      accepted: false;
      refusal: "NOT_FOUND" | "LEASE_LOST" | "NOT_SUBMITTING" | "BAD_OUTCOME";
    };

/**
 * The same confirming rule the adapter path applies, in one place.
 *
 * NON-EMPTY AND OBJECT-SHAPED, because "the extension said so" is the thing being guarded
 * against. Three empty strings are not a confirmation; a URL and some text are.
 */
export function isConfirmingEvidence(evidence: OutcomeEvidence | null | undefined): boolean {
  if (evidence === null || evidence === undefined) {
    return false;
  }
  return Object.values(evidence).some((value) => typeof value === "string" && value.trim() !== "");
}

interface AttemptRow {
  id: string;
  application_plan_id: string;
  status: string;
  lease_token: string | null;
}

interface PlanRow {
  id: string;
  candidate_id: string;
}

/**
 * Clears the lease. Called on EVERY outcome, including the one that keeps the attempt in
 * 'submitting' - the extension has finished its work either way, and leaving a lease open
 * on an attempt nobody is working on only invites a second worker to pick it up later.
 */
function releaseLease(now: Date) {
  return { lease_token: null, leased_until: null, updated_at: now.toISOString() };
}

export async function reportAutoApplyOutcome(
  client: SupabaseClient,
  input: ReportOutcomeInput,
): Promise<ReportOutcomeResult> {
  const now = input.now ?? (() => new Date());

  if (input.outcome !== "succeeded" && input.outcome !== "failed") {
    return { accepted: false, refusal: "BAD_OUTCOME" };
  }

  // 1. Load the attempt and its plan; ownership from rows, never from the request.
  const { data: attemptData, error: attemptError } = await client
    .from("application_attempts")
    .select("id, application_plan_id, status, lease_token")
    .eq("id", input.attemptId)
    .maybeSingle();

  if (attemptError) {
    throw attemptError;
  }

  const attempt = attemptData as AttemptRow | null;
  if (!attempt) {
    return { accepted: false, refusal: "NOT_FOUND" };
  }

  const { data: planData, error: planError } = await client
    .from("application_plans")
    .select("id, candidate_id")
    .eq("id", attempt.application_plan_id)
    .maybeSingle();

  if (planError) {
    throw planError;
  }

  const plan = planData as PlanRow | null;

  // Same answer for "not yours" and "does not exist", so this cannot be used to probe.
  if (!plan || plan.candidate_id !== input.candidateId) {
    return { accepted: false, refusal: "NOT_FOUND" };
  }

  // 2. The caller must hold the lease, and the attempt must be mid-submission.
  if (attempt.lease_token === null || attempt.lease_token !== input.leaseToken) {
    return { accepted: false, refusal: "LEASE_LOST" };
  }

  // ONLY 'submitting' MAY REPORT. An attempt that never passed the authorisation endpoint
  // has no business reporting an outcome, and accepting one would be a second way to reach
  // 'succeeded' that skips the gates entirely.
  if (attempt.status !== "submitting") {
    return { accepted: false, refusal: "NOT_SUBMITTING" };
  }

  const stamp = now();

  // 3. FAILURE - the straightforward half.
  if (input.outcome === "failed") {
    const message = input.error?.message?.trim() ? input.error.message : "The submission did not complete.";

    const evidence = await client.from("application_evidence").insert({
      application_attempt_id: attempt.id,
      evidence_type: "submission_error",
      payload: {
        message,
        reportedBy: "browser_extension",
        ...(input.error?.reasonCode ? { reasonCode: input.error.reasonCode } : {}),
        ...(typeof input.error?.retryable === "boolean" ? { retryable: input.error.retryable } : {}),
      },
    });

    if (evidence.error) {
      throw evidence.error;
    }

    const update = await client
      .from("application_attempts")
      .update({ status: "failed", last_error: message, ...releaseLease(stamp) })
      .eq("id", attempt.id)
      .select("id")
      .maybeSingle();

    if (update.error) {
      throw update.error;
    }
    if (!update.data) {
      // Lost a race against another reporter. The evidence is written either way, so the
      // candidate can still see what happened.
      return { accepted: false, refusal: "LEASE_LOST" };
    }

    return { accepted: true, finalStatus: "failed" };
  }

  // 4. SUCCESS - and the whole point of this module is the branch below it.
  const confirming = isConfirmingEvidence(input.evidence);

  if (!confirming) {
    // REPORTED SENT, PROVEN BY NOTHING. The evidence is still written, because what the
    // extension saw is worth keeping - but it is NOT written as the canonical acceptance
    // type, because that constant is what every reader keys on to mean "verified".
    const evidence = await client.from("application_evidence").insert({
      application_attempt_id: attempt.id,
      evidence_type: "submission_unverified",
      payload: {
        reportedBy: "browser_extension",
        reportedOutcome: "succeeded",
        note: "The extension reported success without a confirmation URL, reference or text.",
        ...(input.evidence ?? {}),
      },
    });

    if (evidence.error) {
      throw evidence.error;
    }

    // THE STATUS IS DELIBERATELY LEFT AT 'submitting'. It is not succeeded (nothing proves
    // it) and not failed (nothing says it did not happen). 'submitting' is the claim
    // predicate's dead end, so nothing will resubmit it automatically - a duplicate
    // application is a worse outcome than an unverified one.
    const update = await client
      .from("application_attempts")
      .update({ ...releaseLease(stamp) })
      .eq("id", attempt.id)
      .select("id")
      .maybeSingle();

    if (update.error) {
      throw update.error;
    }

    return { accepted: true, finalStatus: "needs_verification" };
  }

  // 5. CONFIRMED. This is the only path in the extension flow that reaches 'succeeded'.
  const evidence = await client.from("application_evidence").insert({
    application_attempt_id: attempt.id,
    evidence_type: ACCEPTANCE_EVIDENCE_TYPE,
    payload: { reportedBy: "browser_extension", ...input.evidence },
  });

  if (evidence.error) {
    // The attempt stays 'submitting': the portal may well have accepted it, but we hold no
    // receipt and will not claim one. Same treatment the adapter path gives a failed
    // receipt write.
    return { accepted: true, finalStatus: "needs_verification" };
  }

  const succeededAt = stamp.toISOString();
  const update = await client
    .from("application_attempts")
    .update({ status: "succeeded", succeeded_at: succeededAt, ...releaseLease(stamp) })
    .eq("id", attempt.id)
    .select("id")
    .maybeSingle();

  if (update.error) {
    throw update.error;
  }
  if (!update.data) {
    // The receipt IS stored, so recovery can finish this without the extension.
    return { accepted: true, finalStatus: "needs_verification" };
  }

  // succeeded_at is written HERE and nowhere else, for the same reason the adapter path
  // documents: it is what the anti-ghosting detector measures from, and updated_at cannot
  // serve because unrelated writes move it.
  return { accepted: true, finalStatus: "succeeded" };
}
