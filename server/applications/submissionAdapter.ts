export interface SubmissionContext {
  applicationAttemptId: string;
  applicationPlanId: string;
}

export interface SubmissionResult {
  evidenceType: string;
  payload: Record<string, unknown>;
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
