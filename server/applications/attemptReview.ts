import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSubmissionResume, type ResumeForSubmissionDeps } from "./resumeForSubmission.js";
import {
  createResumePreviewUrl,
  PREVIEW_URL_TTL_SECONDS,
} from "./resumeDocument.js";
import { generateCoverLetter } from "./coverLetterGenerator.js";
import { createOpenAIClient } from "../resumes/openaiClient.js";
import type { SubmissionResume } from "./adapters/types.js";

/**
 * Task U — the review gate.
 *
 * candidate_profiles.review_before_submit has existed since 20260917140000 and
 * the Profile page promises it ("On — you review each application before it is
 * submitted"). Nothing read it until now, so the execution engine dispatched
 * whatever it liked and the UI was describing a workflow that did not exist.
 *
 * The gate is enforced in two halves, deliberately kept in one file so they
 * cannot drift apart:
 *
 *   HOLD   readReviewBeforeSubmit + initialAttemptStatusFor decide, at enqueue
 *          time, whether a new attempt starts as 'pending' (claimable) or
 *          'pending_review' (not claimable by anything).
 *
 *   RELEASE approveAttempt flips a held attempt to 'pending', and only then.
 *
 * The claim query in claim_application_attempt() is an allowlist over
 * 'pending', so the hold is enforced by the database rather than by the
 * cooperation of every caller: a 'pending_review' row cannot be leased by the
 * daemon, by POST /api/worker/run, or by the single-pass CLI. See
 * 20260917190000_attempt_review_gate.sql.
 */

/** Matches the column default in 20260917140000: the safe direction for a review switch. */
export const DEFAULT_REVIEW_BEFORE_SUBMIT = true;

/**
 * Reads the candidate's preference. A missing or non-boolean value resolves to
 * the safe default rather than throwing or defaulting to "no review": an
 * unreadable preference must never be the reason an application is dispatched
 * without the candidate seeing it.
 */
export async function readReviewBeforeSubmit(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("candidate_profiles")
    .select("review_before_submit")
    .eq("id", candidateId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const stored = (data as { review_before_submit?: unknown } | null)?.review_before_submit;

  return typeof stored === "boolean" ? stored : DEFAULT_REVIEW_BEFORE_SUBMIT;
}

/**
 * The status a newly created attempt starts in.
 *
 * 'pending_review' is a hold, not a terminal state — the attempt is still
 * expected to be submitted, once a human says so.
 */
export function initialAttemptStatusFor(reviewBeforeSubmit: boolean): "pending" | "pending_review" {
  return reviewBeforeSubmit ? "pending_review" : "pending";
}

export class ApplicationAttemptNotFoundError extends Error {
  constructor(public readonly applicationAttemptId: string) {
    super(`No application_attempts row exists for id ${applicationAttemptId}`);
    this.name = "ApplicationAttemptNotFoundError";
  }
}

/**
 * The attempt is not sitting in the review queue, so approving it is not a
 * meaningful action. Distinct from "not found" because the statuses imply
 * different things to whoever called: already approved and queued, already
 * submitted, cancelled, or never held at all.
 */
export class AttemptNotAwaitingReviewError extends Error {
  constructor(
    public readonly applicationAttemptId: string,
    public readonly status: string,
    public readonly detail?: string,
  ) {
    super(
      `Application attempt ${applicationAttemptId} is "${status}", not "pending_review"${detail ? ` — ${detail}` : ""}.`,
    );
    this.name = "AttemptNotAwaitingReviewError";
  }
}

export interface ApproveAttemptResult {
  applicationAttemptId: string;
  /** Always 'pending': the state the worker can claim. */
  status: "pending";
  reviewApprovedAt: string;
  /** The document this attempt will submit, prepared as part of approving. */
  resume: SubmissionResume;
  /** False when the attempt already had its resume prepared and this call reused it. */
  resumePrepared: boolean;
}

/**
 * Approves a held attempt: prepares its resume, then releases it to the queue.
 *
 * ORDER IS THE SAFETY PROPERTY. The resume is produced BEFORE the status
 * changes, so a failure to generate one leaves the attempt held rather than
 * releasing an application whose file does not exist yet. The candidate asked
 * to review before submission; a half-prepared attempt that the worker could
 * claim would defeat that.
 *
 * WHY PREPARATION LIVES HERE. Generating a tailored resume costs a model call
 * and a browser render, and the candidate's review is the moment that work is
 * actually wanted. Doing it at enqueue time instead would mean the daemon's
 * candidate x vacancy fan-out generated one resume per eligible pairing on
 * every cycle, for applications nobody had approved yet.
 *
 * CONSEQUENCE, STATED PLAINLY: the candidate approves and the document is
 * produced in the same call, so this endpoint does not by itself give them a
 * PDF to read before saying yes. Approval here means "I accept this
 * application" with the resume prepared at that moment. A review screen that
 * generates the document when the candidate opens it, so they can read it and
 * then approve, needs a candidate-authenticated route — this one is guarded by
 * WORKER_TRIGGER_SECRET and has no notion of who is asking (see the summary).
 */
export async function approveAttempt(
  client: SupabaseClient,
  deps: ResumeForSubmissionDeps,
  input: { applicationAttemptId: string },
): Promise<ApproveAttemptResult> {
  const { data: attempt, error: attemptError } = await client
    .from("application_attempts")
    .select("id, status, application_plan_id, resume_document_id")
    .eq("id", input.applicationAttemptId)
    .maybeSingle();

  if (attemptError) {
    throw attemptError;
  }
  if (!attempt) {
    throw new ApplicationAttemptNotFoundError(input.applicationAttemptId);
  }

  const row = attempt as {
    id: string;
    status: string;
    application_plan_id: string;
    resume_document_id: string | null;
  };

  if (row.status !== "pending_review") {
    throw new AttemptNotAwaitingReviewError(row.id, row.status);
  }

  const { data: plan, error: planError } = await client
    .from("application_plans")
    .select("candidate_id, vacancy_id")
    .eq("id", row.application_plan_id)
    .single();

  if (planError || !plan) {
    throw planError ?? new Error(`application_plans row not found for id ${row.application_plan_id}`);
  }

  const { candidate_id: candidateId, vacancy_id: vacancyId } = plan as {
    candidate_id: string;
    vacancy_id: string;
  };

  const alreadyPrepared = row.resume_document_id !== null;

  // Preparing also writes application_attempts.resume_document_id, so the
  // worker that later claims this attempt reuses this exact file rather than
  // generating a second one.
  const resume = await resolveSubmissionResume(client, deps, {
    applicationAttemptId: row.id,
    candidateId,
    vacancyId,
  });

  const reviewApprovedAt = await releaseAttemptForQueue(client, row.id);

  return {
    applicationAttemptId: row.id,
    status: "pending",
    reviewApprovedAt,
    resume,
    resumePrepared: !alreadyPrepared,
  };
}

/**
 * The single place a held attempt becomes claimable.
 *
 * A compare-and-swap, not a plain update: two concurrent approvals — the
 * candidate tapping twice, or the candidate and the worker route racing — must
 * not both believe they released the attempt. The status predicate is what
 * makes it atomic, and a zero-row result means somebody else already moved it.
 *
 * Every caller goes through here, so "release means pending_review -> pending"
 * is one implementation rather than a rule each route re-expresses.
 */
export async function releaseAttemptForQueue(
  client: SupabaseClient,
  applicationAttemptId: string,
): Promise<string> {
  const reviewApprovedAt = new Date().toISOString();

  const { data: released, error: releaseError } = await client
    .from("application_attempts")
    .update({ status: "pending", review_approved_at: reviewApprovedAt, updated_at: reviewApprovedAt })
    .eq("id", applicationAttemptId)
    .eq("status", "pending_review")
    .select("id");

  if (releaseError) {
    throw releaseError;
  }

  if (!released || released.length === 0) {
    throw new AttemptNotAwaitingReviewError(
      applicationAttemptId,
      "changed",
      "another approval moved it out of pending_review first",
    );
  }

  return reviewApprovedAt;
}

/**
 * Thrown when the attempt exists but belongs to somebody else.
 *
 * Mapped to 404 by the routes, not 403, and deliberately: a 403 confirms the id
 * refers to a real attempt belonging to another candidate, which turns the
 * endpoint into an oracle for guessing attempt ids. "Not yours" and "does not
 * exist" are the same answer from outside.
 */
export class AttemptNotOwnedError extends Error {
  constructor(public readonly applicationAttemptId: string) {
    super(`Application attempt ${applicationAttemptId} does not belong to this candidate`);
    this.name = "AttemptNotOwnedError";
  }
}

/**
 * Thrown when a candidate tries to approve something they were never shown.
 * Mapped to 409: the request is well-formed, it is the attempt's state that
 * does not support the action yet.
 */
export class AttemptNotPreviewedError extends Error {
  constructor(public readonly applicationAttemptId: string) {
    super(
      `Application attempt ${applicationAttemptId} has no prepared resume to approve — generate the preview first.`,
    );
    this.name = "AttemptNotPreviewedError";
  }
}

export interface ReviewableAttempt {
  attemptId: string;
  status: string;
  planId: string;
  candidateId: string;
  vacancyId: string;
  resumeDocumentId: string | null;
}

/**
 * Loads an attempt and proves the caller owns it.
 *
 * application_attempts has no candidate_id column of its own — ownership only
 * exists transitively through application_plans.candidate_id — so this is the
 * two-hop read every ownership question on this table has to make.
 *
 * The read goes through the service-role client, which bypasses RLS, so this
 * function IS the ownership boundary for the candidate routes rather than a
 * second check behind one. The RLS policies on application_attempts already
 * stop Candidate B reading Candidate A's rows (asserted in
 * application_attempts_rls.test.sql), but a service-role read is not subject to
 * them, so the comparison below is not redundant — it is the check.
 */
export async function loadOwnedAttempt(
  client: SupabaseClient,
  candidateId: string,
  applicationAttemptId: string,
): Promise<ReviewableAttempt> {
  const { data: attempt, error: attemptError } = await client
    .from("application_attempts")
    .select("id, status, application_plan_id, resume_document_id")
    .eq("id", applicationAttemptId)
    .maybeSingle();

  if (attemptError) {
    throw attemptError;
  }
  if (!attempt) {
    throw new ApplicationAttemptNotFoundError(applicationAttemptId);
  }

  const row = attempt as {
    id: string;
    status: string;
    application_plan_id: string;
    resume_document_id: string | null;
  };

  const { data: plan, error: planError } = await client
    .from("application_plans")
    .select("candidate_id, vacancy_id")
    .eq("id", row.application_plan_id)
    .maybeSingle();

  if (planError) {
    throw planError;
  }
  if (!plan) {
    throw new ApplicationAttemptNotFoundError(applicationAttemptId);
  }

  const owned = plan as { candidate_id: string; vacancy_id: string };

  if (owned.candidate_id !== candidateId) {
    throw new AttemptNotOwnedError(applicationAttemptId);
  }

  return {
    attemptId: row.id,
    status: row.status,
    planId: row.application_plan_id,
    candidateId: owned.candidate_id,
    vacancyId: owned.vacancy_id,
    resumeDocumentId: row.resume_document_id,
  };
}

/**
 * The cover letter half of a preview.
 *
 * A discriminated outcome rather than a nullable string, because "there is no
 * letter" and "the letter failed the honesty gate" are different things and the
 * candidate should be told which. A letter is supplementary — the application
 * is complete without one — so a failure here never fails the preview, but it
 * must never be silent either.
 */
export type CoverLetterOutcome =
  | {
      kind: "generated";
      text: string;
      paragraphs: Array<{ text: string; factRefs: string[] }>;
      promptVersion: string;
      modelVersion: string;
      citedFactCount: number;
      generatedAt: string;
    }
  | { kind: "failed"; reason: string };

export interface AttemptPreview {
  applicationAttemptId: string;
  status: string;
  resume: SubmissionResume;
  /** Time-limited URL for the PDF. See createResumePreviewUrl for the TTL and its tradeoff. */
  previewUrl: string;
  previewUrlExpiresInSeconds: number;
  /** False when the attempt already had its resume prepared and this call reused it. */
  resumePrepared: boolean;
  /** The letter this attempt will send alongside the resume, or why there isn't one. */
  coverLetter: CoverLetterOutcome;
}

/**
 * Produces the resume this attempt will submit, and a link to read it.
 *
 * Restricted to pending_review. The point of the endpoint is the review
 * workflow, and generating a document for an attempt that has already been
 * dispatched, cancelled or failed would either be busy-work or would quietly
 * create a file nothing will ever send. A candidate who wants to re-read a
 * resume from a past application has the Resumes page for their own uploads;
 * tailored documents are per-application artifacts, not a library.
 */
export async function generateAttemptPreview(
  client: SupabaseClient,
  deps: ResumeForSubmissionDeps,
  input: { candidateId: string; applicationAttemptId: string },
): Promise<AttemptPreview> {
  const attempt = await loadOwnedAttempt(client, input.candidateId, input.applicationAttemptId);

  if (attempt.status !== "pending_review") {
    throw new AttemptNotAwaitingReviewError(attempt.attemptId, attempt.status);
  }

  const alreadyPrepared = attempt.resumeDocumentId !== null;

  const openai = (deps.createOpenAIClient ?? createOpenAIClient)();

  // IN PARALLEL. The two are independent — one renders a document, the other
  // writes prose — and both spend most of their time waiting on a model, so
  // running them in sequence would roughly double how long the candidate
  // watches a spinner. The duplicate fact and JD reads this causes are two
  // indexed lookups each, which is a much better trade than serially waiting on
  // two model round trips.
  //
  // Note the asymmetry in failure handling, which is deliberate: the resume is
  // required (a rejected promise propagates and the preview fails, as before),
  // the letter is not. A letter that failed the honesty gate must not block an
  // application that is otherwise ready to send — but it must be reported, not
  // swallowed, so the candidate is never shown a preview that quietly omits
  // something they asked for.
  const [resume, coverLetter] = await Promise.all([
    resolveSubmissionResume(client, deps, {
      applicationAttemptId: attempt.attemptId,
      candidateId: attempt.candidateId,
      vacancyId: attempt.vacancyId,
    }),
    generateCoverLetter(client, { openai }, {
      candidateId: attempt.candidateId,
      vacancyId: attempt.vacancyId,
    }).then(
      (letter): CoverLetterOutcome => ({
        kind: "generated",
        text: letter.text,
        paragraphs: letter.paragraphs,
        promptVersion: letter.promptVersion,
        modelVersion: letter.modelVersion,
        citedFactCount: letter.citedFactCount,
        generatedAt: letter.metadata.generatedAt,
      }),
      (error: unknown): CoverLetterOutcome => ({
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }),
    ),
  ]);

  // Persist the letter and its provenance together, as one write. The database
  // enforces that pairing (application_attempts_cover_letter_provenance_check),
  // so a future caller cannot store one without the other.
  if (coverLetter.kind === "generated") {
    const { error: letterError } = await client
      .from("application_attempts")
      .update({
        cover_letter_text: coverLetter.text,
        cover_letter_model_version: coverLetter.modelVersion,
        cover_letter_prompt_version: coverLetter.promptVersion,
        cover_letter_generated_at: coverLetter.generatedAt,
        cover_letter_metadata: {
          promptVersion: coverLetter.promptVersion,
          modelVersion: coverLetter.modelVersion,
          generatedAt: coverLetter.generatedAt,
          citedFactCount: coverLetter.citedFactCount,
          citations: coverLetter.paragraphs.map((paragraph, index) => ({
            paragraphIndex: index,
            factRefs: paragraph.factRefs,
          })),
          vacancyId: attempt.vacancyId,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", attempt.attemptId);

    if (letterError) {
      // Same asymmetry: the resume is prepared and the preview is still usable,
      // so this is reported rather than thrown. A letter that generated but
      // could not be stored must not look like one that generated fine.
      return {
        applicationAttemptId: attempt.attemptId,
        status: attempt.status,
        resume,
        previewUrl: await createResumePreviewUrl(client, resume.storagePath),
        previewUrlExpiresInSeconds: PREVIEW_URL_TTL_SECONDS,
        resumePrepared: !alreadyPrepared,
        coverLetter: { kind: "failed", reason: `generated but could not be stored: ${letterError.message}` },
      };
    }
  }

  const previewUrl = await createResumePreviewUrl(client, resume.storagePath);

  return {
    applicationAttemptId: attempt.attemptId,
    status: attempt.status,
    resume,
    previewUrl,
    previewUrlExpiresInSeconds: PREVIEW_URL_TTL_SECONDS,
    resumePrepared: !alreadyPrepared,
    coverLetter,
  };
}

export interface CandidateApprovalResult {
  applicationAttemptId: string;
  status: "pending";
  reviewApprovedAt: string;
}

/**
 * The candidate's own approval: releases a held attempt they own.
 *
 * REQUIRES A PREPARED RESUME, and that is the whole point of the workflow. The
 * worker-authenticated route prepares on demand because it has no candidate to
 * ask; here, approving without a document would mean approving something the
 * candidate was never shown, which is exactly the promise
 * review_before_submit exists to keep. A missing document is a 409 telling the
 * caller to generate the preview first, not something silently generated at the
 * moment of approval.
 *
 * This function does NOT re-prepare or re-check the preference. What was
 * previewed is what gets sent, even if the optimization level changed in
 * between — the candidate approved a specific file.
 */
export async function approveOwnedAttempt(
  client: SupabaseClient,
  input: { candidateId: string; applicationAttemptId: string },
): Promise<CandidateApprovalResult> {
  const attempt = await loadOwnedAttempt(client, input.candidateId, input.applicationAttemptId);

  if (attempt.status !== "pending_review") {
    throw new AttemptNotAwaitingReviewError(attempt.attemptId, attempt.status);
  }

  if (attempt.resumeDocumentId === null) {
    throw new AttemptNotPreviewedError(attempt.attemptId);
  }

  const reviewApprovedAt = await releaseAttemptForQueue(client, attempt.attemptId);

  return { applicationAttemptId: attempt.attemptId, status: "pending", reviewApprovedAt };
}
