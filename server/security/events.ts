import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Task H4 — recording detections from the untrusted-content defences that RI PRD
 * §10.3 requires.
 *
 * WHY A TABLE AND NOT A LOG LINE. §10.3's controls are only meaningful if a
 * refusal is visible. A sanitizer that silently rewrites text is
 * indistinguishable from one that is not running at all, and an injection
 * attempt against this product is a fact somebody should be able to query
 * ("has anything tried to make our model exfiltrate a token?") rather than
 * something that scrolled past in a container log three weeks ago.
 *
 * Best-effort like the audit log: a security-detection write must never be the
 * reason a candidate's email fails to classify.
 */

export type SecurityEventType =
  | "active_html_stripped"
  | "script_tag_removed"
  | "tracking_pixel_removed"
  | "event_handler_removed"
  | "disallowed_link_scheme"
  | "suspicious_link_domain"
  | "prompt_injection_suspected"
  | "instruction_override_attempt"
  | "secret_disclosure_request"
  | "unauthorised_action_request";

export type SecuritySeverity = "low" | "medium" | "high";

export type SecuritySource = "jd_text" | "email_body" | "email_html" | "attachment" | "web_page" | "other";

export interface SecurityEventInput {
  eventType: SecurityEventType;
  severity: SecuritySeverity;
  source: SecuritySource;
  subjectId?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface SecurityEventRecord extends SecurityEventInput {
  id: string;
  occurredAt: string;
}

export async function recordSecurityEvent(
  client: SupabaseClient,
  input: SecurityEventInput,
): Promise<void> {
  // Wrapped whole, for the same reason recordAuditEvent is: the builder can
  // throw as well as return an error, and this call sits on the classification
  // path where a detection must never be the reason a real email fails.
  let error: { message: string } | null = null;

  try {
    const result = await client.from("security_events").insert({
      event_type: input.eventType,
      severity: input.severity,
      source: input.source,
      subject_id: input.subjectId ?? null,
      detail: input.detail ?? null,
    });
    error = result.error ?? null;
  } catch (thrown) {
    error = { message: thrown instanceof Error ? thrown.message : String(thrown) };
  }

  if (error) {
    console.error("[security] FAILED TO RECORD SECURITY EVENT", {
      eventType: input.eventType,
      source: input.source,
      error: error.message,
    });
  }
}

interface SecurityRow {
  id: string;
  occurred_at: string;
  event_type: SecurityEventType;
  severity: SecuritySeverity;
  source: SecuritySource;
  subject_id: string | null;
  detail: Record<string, unknown> | null;
}

export async function listSecurityEvents(
  client: SupabaseClient,
  options: { limit?: number } = {},
): Promise<SecurityEventRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);

  const { data, error } = await client
    .from("security_events")
    .select("id, occurred_at, event_type, severity, source, subject_id, detail")
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return ((data ?? []) as SecurityRow[]).map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    eventType: row.event_type,
    severity: row.severity,
    source: row.source,
    subjectId: row.subject_id,
    detail: row.detail,
  }));
}
