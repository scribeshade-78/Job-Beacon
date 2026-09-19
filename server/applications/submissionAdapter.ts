import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionRequiredExceptionType } from "./actionRequired.js";
import { resolveApplicationAdapter } from "./adapters/registry.js";
import type { ApplicationSubmissionContext, ApplicationSubmissionResult } from "./adapters/types.js";
import { resolveSubmissionResume, type ResumeForSubmissionDeps } from "./resumeForSubmission.js";

export type SubmissionContext = ApplicationSubmissionContext;
export type SubmissionResult = ApplicationSubmissionResult;

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
 * R7-M4: thrown when the candidate's current automation_authorizations.status
 * is not 'authorized' at the moment submission is about to be dispatched.
 * worker.ts routes this to a dedicated 'cancelled' outcome (see that
 * file), never the generic retry/dead-letter path a plain Error takes and
 * never the action_required path — this is not a submission failure and
 * not something the candidate needs to act on to unblock (they already
 * acted, by pausing/stopping).
 */
export class AuthorizationWithdrawnError extends Error {
  constructor(public readonly status: string) {
    super(`Candidate automation authorization is "${status}", not "authorized" — submission cancelled.`);
    this.name = "AuthorizationWithdrawnError";
  }
}

/**
 * PRD §16.2 names 5 channels (Authorized ATS API, Permitted hosted form,
 * Employer direct API/feed, Redirect-only source, Unsupported/restricted).
 * R7-M2 replaces this function's original unconditional throw with a real
 * (if currently always-"unsupported") resolution: look up the attempt's
 * vacancy source_code — application_attempts carries no source_code column
 * of its own, so this goes through application_plans -> vacancies, the
 * same two-hop shape eligibilityGate.ts's own gates already use — then
 * dispatch through resolveApplicationAdapter (PRD §23.2's "evaluate source
 * capabilities at runtime" requirement). Every source still resolves to
 * unsupportedAdapter today (see registry.ts), so the practical outcome for
 * every real caller is unchanged: a thrown error, routed by worker.ts's
 * existing catch block to the generic retry/dead-letter path.
 *
 * R7-M4: also re-checks automation_authorizations immediately before
 * dispatching to the adapter — the closest point to the actual external
 * effect this architecture allows (see the R7-M4 migration's comment for
 * why the primary safety boundary is claim_application_attempt's
 * pre-lease cancellation sweep, and why this is deliberately a second,
 * narrower layer rather than the only one). Uses the same
 * candidate_id/vacancy_id read as the existing plan lookup — one query,
 * not two.
 */
export async function submitApplicationAttempt(
  client: SupabaseClient,
  context: SubmissionContext,
  deps: ResumeForSubmissionDeps = {},
): Promise<SubmissionResult> {
  const { data: plan, error: planError } = await client
    .from("application_plans")
    .select("vacancy_id, candidate_id")
    .eq("id", context.applicationPlanId)
    .single();

  if (planError || !plan) {
    throw planError ?? new Error(`application_plans row not found for id ${context.applicationPlanId}`);
  }

  const { vacancy_id: vacancyId, candidate_id: candidateId } = plan as {
    vacancy_id: string;
    candidate_id: string;
  };

  const { data: authorization, error: authorizationError } = await client
    .from("automation_authorizations")
    .select("status")
    .eq("candidate_id", candidateId)
    .maybeSingle();

  if (authorizationError) {
    throw authorizationError;
  }

  const authorizationStatus = (authorization as { status: string } | null)?.status ?? "not_yet_authorized";

  if (authorizationStatus !== "authorized") {
    throw new AuthorizationWithdrawnError(authorizationStatus);
  }

  const { data: vacancy, error: vacancyError } = await client
    .from("vacancies")
    .select("source_code")
    .eq("id", vacancyId)
    .single();

  if (vacancyError || !vacancy) {
    throw vacancyError ?? new Error(`vacancies row not found for id ${vacancyId}`);
  }

  const adapter = resolveApplicationAdapter((vacancy as { source_code: string }).source_code);

  // Mini-Phase 11: the resume is resolved here, in the one place every adapter
  // is dispatched from, so "which file does this application send" has exactly
  // one answer — the same reason the authorization recheck above lives here
  // rather than in each adapter.
  //
  // Guarded on the adapter's own capability flag: an adapter that cannot submit
  // automatically will throw on the next line regardless, and generating a
  // tailored resume (a model call plus a browser render) for an application
  // that cannot be made is work with no outcome. The flag is the adapter's, not
  // a second opinion derived here.
  if (!adapter.isAutomatedSubmissionSupported) {
    return adapter.submit(client, context);
  }

  const resume = await resolveSubmissionResume(client, deps, {
    applicationAttemptId: context.applicationAttemptId,
    candidateId,
    vacancyId,
  });

  return adapter.submit(client, { ...context, resume });
}
