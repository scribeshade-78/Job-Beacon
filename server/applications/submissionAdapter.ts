import type { ActionRequiredExceptionType } from "./actionRequired.js";

export interface SubmissionContext {
  applicationAttemptId: string;
  applicationPlanId: string;
}

export interface SubmissionResult {
  evidenceType: string;
  payload: Record<string, unknown>;
}

/**
 * PRD §17's contract for a channel adapter that hits one of the seven
 * named exceptions mid-submission (a CAPTCHA, an OTP prompt, a portal it
 * doesn't support, etc.): throw this instead of a plain Error, and
 * worker.ts's catch block routes it to createActionRequiredEvent (a pause,
 * PRD §17.1) rather than the generic retry/dead-letter path a submission
 * failure takes. No real channel adapter throws this yet — same "the
 * contract exists and is tested ahead of the first real adapter landing"
 * precedent as this file's own SubmissionResult/success path (R4.3).
 */
export class ActionRequiredSubmissionError extends Error {
  constructor(
    public readonly exceptionType: ActionRequiredExceptionType,
    public readonly payload: Record<string, unknown>,
    public readonly expiresAt?: string,
  ) {
    super(`Submission requires candidate action: ${exceptionType}`);
    this.name = "ActionRequiredSubmissionError";
  }
}

/**
 * PRD §16.2 names 5 channels (Authorized ATS API, Permitted hosted form,
 * Employer direct API/feed, Redirect-only source, Unsupported/restricted)
 * — none has an adapter implementation anywhere in this repository, and
 * source_policies.automated_application_allowed is false for every source
 * today (R2's explicit decision), so no channel could route to a real
 * adapter even if one existed. This always throws so worker.ts's error
 * and evidence-recording path is exercised honestly against a real
 * failure, not a submission that silently pretends to succeed. Real
 * per-channel adapters (browser worker, ATS API client, etc.) are a
 * later R4 mini-phase, not built here.
 */
export async function submitApplicationAttempt(_context: SubmissionContext): Promise<SubmissionResult> {
  throw new Error(
    "No submission adapter is registered for any channel yet (PRD §16.2) — application channels are not implemented.",
  );
}
