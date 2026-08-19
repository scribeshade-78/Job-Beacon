import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PRD §17's seven named exception types (action_required_events.exception_type
 * check constraint), verbatim — same "match the source document's own
 * enumeration exactly" discipline as the migration comment, and the same
 * manual-sync-across-the-tsconfig-boundary precedent as
 * APPLICATION_ATTEMPT_STATUSES.
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

export interface ActionRequiredEvent {
  id: string;
  exceptionType: ActionRequiredExceptionType;
  payload: unknown;
  expiresAt: string | null;
  createdAt: string;
  vacancyTitle: string;
  vacancyUrl: string;
}

interface ActionRequiredEventRow {
  id: string;
  exception_type: ActionRequiredExceptionType;
  payload: unknown;
  expires_at: string | null;
  created_at: string;
  application_attempts: {
    application_plans: {
      vacancies: { raw_title: string; authoritative_url: string } | null;
    } | null;
  } | null;
}

const GENERIC_FAILURE_MESSAGE = "Could not load items needing your action. Please try again.";

export type ListActionRequiredEventsResult =
  | { kind: "success"; events: ActionRequiredEvent[] }
  | { kind: "error"; message: string };

/**
 * Reads the caller's own unresolved action_required_events — RLS
 * (action_required_events_select_own) scopes rows two joins deep to
 * auth.uid() via application_attempts -> application_plans, so this is a
 * direct query, matching every other candidate self-read in this file's
 * sibling modules. Only resolved_at IS NULL rows are returned: this is the
 * PRD §18.1 "Action Required" nav item, i.e. what still needs the
 * candidate's attention right now, not a history of past exceptions.
 */
export async function listActionRequiredEvents(
  client: Pick<SupabaseClient, "from">,
): Promise<ListActionRequiredEventsResult> {
  try {
    const { data, error } = await client
      .from("action_required_events")
      .select(
        "id, exception_type, payload, expires_at, created_at, application_attempts (application_plans (vacancies (raw_title, authoritative_url)))",
      )
      .is("resolved_at", null)
      .order("created_at", { ascending: false });

    if (error || !data) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    const rows = data as unknown as ActionRequiredEventRow[];

    return {
      kind: "success",
      events: rows.map((row) => {
        const vacancy = row.application_attempts?.application_plans?.vacancies ?? null;

        return {
          id: row.id,
          exceptionType: row.exception_type,
          payload: row.payload,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          vacancyTitle: vacancy?.raw_title ?? "",
          vacancyUrl: vacancy?.authoritative_url ?? "",
        };
      }),
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}
