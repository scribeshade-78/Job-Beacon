import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PRD §17's seven named exception types (action_required_events.exception_type
 * check constraint), verbatim — same manual-sync-across-the-tsconfig-boundary
 * precedent as client/src/lib/actionRequired.ts's copy of this list: server
 * and client are separate TypeScript projects (see tsconfig.json vs
 * tsconfig.server.json), so importing across that boundary isn't possible,
 * and both copies must be kept in sync with the migration by hand.
 */
export const ACTION_REQUIRED_EXCEPTION_TYPES = [
  "captcha",
  "otp_or_email_code",
  "unknown_sensitive_question",
  "missing_verified_fact",
  "external_assessment",
  "unsupported_portal",
  "payment_or_financial_request",
] as const;

export type ActionRequiredExceptionType = (typeof ACTION_REQUIRED_EXCEPTION_TYPES)[number];

export interface ActionRequiredEventRecord {
  id: string;
  applicationAttemptId: string;
  exceptionType: ActionRequiredExceptionType;
  payload: Record<string, unknown>;
  expiresAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

interface ActionRequiredEventRow {
  id: string;
  application_attempt_id: string;
  exception_type: ActionRequiredExceptionType;
  payload: Record<string, unknown>;
  expires_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

function mapEventRow(row: ActionRequiredEventRow): ActionRequiredEventRecord {
  return {
    id: row.id,
    applicationAttemptId: row.application_attempt_id,
    exceptionType: row.exception_type,
    payload: row.payload,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

const EVENT_SELECT_COLUMNS = "id, application_attempt_id, exception_type, payload, expires_at, resolved_at, created_at";

export interface CreateActionRequiredEventInput {
  applicationAttemptId: string;
  exceptionType: ActionRequiredExceptionType;
  payload: Record<string, unknown>;
  expiresAt?: string;
}

/**
 * PRD §17.1: records one of the seven named exceptions against an
 * in-flight attempt and pauses it — sets application_attempts.status to
 * 'action_required', a status claim_application_attempt()'s WHERE clause
 * never matches (only 'pending' and lease-expired 'leased' rows are
 * claimable), so the worker leaves this attempt alone until
 * resolveActionRequiredEvent explicitly resumes it.
 *
 * Two separate writes, not one transaction — no RPC exists for this yet,
 * matching runOneApplicationAttempt's own existing non-transactional
 * evidence-insert-then-status-update pairs. A torn write here just leaves
 * an attempt with an event recorded but still 'leased' (the worker's
 * 5-minute lease expires and it becomes reclaimable again, which is a
 * safe failure mode), not a silently lost pause.
 */
export async function createActionRequiredEvent(
  client: SupabaseClient,
  input: CreateActionRequiredEventInput,
): Promise<ActionRequiredEventRecord> {
  const { data, error } = await client
    .from("action_required_events")
    .insert({
      application_attempt_id: input.applicationAttemptId,
      exception_type: input.exceptionType,
      payload: input.payload,
      expires_at: input.expiresAt ?? null,
    })
    .select(EVENT_SELECT_COLUMNS)
    .single();

  if (error || !data) {
    throw error ?? new Error("Failed to insert action_required_events row");
  }

  const { error: updateError } = await client
    .from("application_attempts")
    .update({ status: "action_required", updated_at: new Date().toISOString() })
    .eq("id", input.applicationAttemptId);

  if (updateError) {
    throw updateError;
  }

  return mapEventRow(data as unknown as ActionRequiredEventRow);
}

export interface ResolveActionRequiredEventInput {
  eventId: string;
}

/**
 * R7-M15 (PRD §16.4 / R7-M4's authorization-withdrawal safety net):
 * resolving an action-required event is a third re-entry point into the
 * claimable queue, alongside claim_application_attempt()'s own cancellation
 * sweep and submitApplicationAttempt's pre-dispatch recheck — without this,
 * resuming a paused/stopped candidate's attempt to 'pending' would
 * (transiently) misrepresent already-withdrawn consent as still active,
 * even though the sweep/recheck would still stop any actual submission
 * (this closes a data-accuracy gap, not a safety hole — defense in depth,
 * not the only safeguard). Reuses the exact "no authorized row = not
 * authorized" fail-safe default evaluateAutomationAuthorization and
 * claim_application_attempt() already apply — not a second, independent
 * definition of authorization.
 *
 * Resolves candidate_id via application_attempts -> application_plans,
 * since resolveActionRequiredEvent starts only with an eventId (and, via
 * the event row, an applicationAttemptId) — the same two-hop shape
 * eligibilityGate.ts's own gates already use to get from an attempt to its
 * owning candidate.
 */
async function isCandidateAuthorized(client: SupabaseClient, applicationAttemptId: string): Promise<boolean> {
  const { data: attempt, error: attemptError } = await client
    .from("application_attempts")
    .select("application_plan_id")
    .eq("id", applicationAttemptId)
    .single();

  if (attemptError || !attempt) {
    throw attemptError ?? new Error(`application_attempts row not found for id ${applicationAttemptId}`);
  }

  const { application_plan_id: applicationPlanId } = attempt as { application_plan_id: string };

  const { data: plan, error: planError } = await client
    .from("application_plans")
    .select("candidate_id")
    .eq("id", applicationPlanId)
    .single();

  if (planError || !plan) {
    throw planError ?? new Error(`application_plans row not found for id ${applicationPlanId}`);
  }

  const { data: authorization, error: authorizationError } = await client
    .from("automation_authorizations")
    .select("status")
    .eq("candidate_id", (plan as { candidate_id: string }).candidate_id)
    .maybeSingle();

  if (authorizationError) {
    throw authorizationError;
  }

  return (authorization as { status: string } | null)?.status === "authorized";
}

/**
 * PRD §17.1 "Resume automatically after successful completion": marks the
 * event resolved and, if the candidate is still authorized, resumes the
 * underlying attempt by moving it back to 'pending' — the status
 * worker.ts's own comments document as immediately reclaimable by
 * claim_application_attempt() regardless of leased_until. R7-M15: if the
 * candidate is no longer authorized (paused, stopped, or the row is
 * missing), the attempt is moved to 'cancelled' instead — the same
 * terminal state R7-M4's claim-time sweep and submission-time recheck
 * already use for the identical situation, not a new one. Neither branch
 * touches application_attempts.attempts: an action-required pause (or its
 * resolution) is not a failed submission attempt, so it shouldn't count
 * against max_attempts.
 *
 * The event itself is always marked resolved, in both branches — audit
 * behavior is about whether this pause was dealt with, not about which way
 * the underlying attempt went, so a withdrawn-consent candidate doesn't
 * leave the event artificially stuck unresolved.
 *
 * Resolving an already-resolved event is an idempotent no-op — same
 * "duplicate action succeeds without redoing side effects" precedent as
 * exclusions.ts's setExclusion treating a duplicate insert as success —
 * rather than an error or a silent resolved_at overwrite: the original
 * resolution time is audit evidence, and the underlying attempt may have
 * long since moved on its own (succeeded, failed, or been claimed again),
 * so a second resolve must not touch it. The attempt-status update is
 * additionally scoped to status = 'action_required' as defense in depth
 * against exactly that case.
 */
export async function resolveActionRequiredEvent(
  client: SupabaseClient,
  input: ResolveActionRequiredEventInput,
): Promise<ActionRequiredEventRecord> {
  const { data: existingRow, error: fetchError } = await client
    .from("action_required_events")
    .select(EVENT_SELECT_COLUMNS)
    .eq("id", input.eventId)
    .maybeSingle();

  if (fetchError) {
    throw fetchError;
  }
  if (!existingRow) {
    throw new Error(`action_required_events row not found for id ${input.eventId}`);
  }

  const existingEvent = mapEventRow(existingRow as unknown as ActionRequiredEventRow);

  if (existingEvent.resolvedAt !== null) {
    return existingEvent;
  }

  const { data, error } = await client
    .from("action_required_events")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", input.eventId)
    .select(EVENT_SELECT_COLUMNS)
    .single();

  if (error || !data) {
    throw error ?? new Error(`action_required_events row not found for id ${input.eventId}`);
  }

  const event = mapEventRow(data as unknown as ActionRequiredEventRow);

  const isAuthorized = await isCandidateAuthorized(client, event.applicationAttemptId);

  // Mirrors worker.ts's own cancelled-branch precedent (AuthorizationWithdrawnError):
  // no leased_until touch on cancellation, since it was never a live lease being
  // cleared, only its own resume-to-pending branch clears it.
  const attemptUpdate = isAuthorized
    ? { status: "pending", leased_until: null, updated_at: new Date().toISOString() }
    : { status: "cancelled", updated_at: new Date().toISOString() };

  const { error: updateError } = await client
    .from("application_attempts")
    .update(attemptUpdate)
    .eq("id", event.applicationAttemptId)
    .eq("status", "action_required");

  if (updateError) {
    throw updateError;
  }

  return event;
}
