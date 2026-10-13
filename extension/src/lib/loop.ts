
/**
 * THE PURE HALF OF THE EXTENSION LOOP.
 *
 * Everything here is a function of its arguments, so the two decisions that actually matter -
 * which attempt a page belongs to, and whether a submission happened - can be tested without
 * a browser, a portal, or a network. The chrome and DOM code that calls into this is thin on
 * purpose: it is the part that cannot be tested here, so it holds as little judgement as
 * possible.
 */

/** The query parameter the Tracker appends to a job-board URL. */
export const ATTEMPT_PARAM = "jb_attempt_id";

/**
 * Which attempt this page was opened for, or undefined when it was opened normally.
 *
 * UNDEFINED IS THE COMMON CASE AND THE SAFE ONE. A candidate browsing a job board without
 * launching from the Tracker must have nothing happen at all - no fill, no prompt. Guessing
 * an attempt here is how a form gets submitted against the wrong application.
 */
export function readAttemptId(url: string): string | undefined {
  try {
    const value = new URL(url).searchParams.get(ATTEMPT_PARAM);
    if (value === null) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    // An unparseable URL is not this function's problem to report. No id means no action.
    return undefined;
  }
}

export interface SubmissionEvidence {
  confirmationUrl?: string;
  confirmationText?: string;
}

export interface SubmissionError {
  message: string;
  reasonCode?: string;
  retryable?: boolean;
}

export interface EvidenceInput {
  confirmationUrl?: string | null;
  confirmationText?: string | null;
  error?: SubmissionError | null;
}

export type SubmissionOutcome = "succeeded" | "needs_verification" | "failed";

export interface Classification {
  outcome: SubmissionOutcome;
  evidence?: SubmissionEvidence;
  error?: SubmissionError;
}

function nonBlank(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * What actually happened, judged only on what was SEEN.
 *
 * A CLICK THAT DID NOT THROW IS NOT EVIDENCE THAT ANYTHING WAS SENT. The submit button can
 * be found, clicked, and swallowed by a client-side handler that never reaches the server;
 * the portal can reject the form; the click can land on the wrong element. If nothing
 * confirms the submission, the honest answer is needs_verification - which the Tracker
 * already renders as "Action Required: Verify Submission" - and never succeeded.
 *
 * PROOF BEATS AN ERROR. Something can go wrong after the portal has already accepted the
 * application - a dropped connection, a failed redirect, a script error while closing the
 * tab. A confirmation that was actually seen is positive evidence, and a later throw must not
 * downgrade it to failed. The order below is therefore: confirmation, then error, then the
 * honest unknown.
 */
export function classifySubmissionEvidence(input: EvidenceInput): Classification {
  const confirmationUrl = nonBlank(input.confirmationUrl);
  const confirmationText = nonBlank(input.confirmationText);

  if (confirmationUrl !== undefined || confirmationText !== undefined) {
    const evidence: SubmissionEvidence = {};
    // Copied field by field rather than spread, so a null never travels as a value on the
    // wire: the server's confirming rule treats a key holding null differently from an
    // absent key, and an explicit null would be a claim we did not mean to make.
    if (confirmationUrl !== undefined) {
      evidence.confirmationUrl = confirmationUrl;
    }
    if (confirmationText !== undefined) {
      evidence.confirmationText = confirmationText;
    }
    return { outcome: "succeeded", evidence };
  }

  const message = nonBlank(input.error?.message);
  if (message !== undefined) {
    return {
      outcome: "failed",
      error: {
        message,
        ...(input.error?.reasonCode ? { reasonCode: input.error.reasonCode } : {}),
        ...(typeof input.error?.retryable === "boolean" ? { retryable: input.error.retryable } : {}),
      },
    };
  }

  return { outcome: "needs_verification" };
}
