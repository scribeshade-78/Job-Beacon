import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Task H4 — writing and reading audit_events (PRD v3 §21.1, fields per RI PRD §15).
 *
 * BEST-EFFORT, AND THAT IS A TRADE-OFF WORTH STATING. recordAuditEvent never
 * throws. A logging failure therefore cannot fail the action it was recording,
 * which is the right call for a moderation decision: refusing to record a
 * decision because the audit insert failed would leave the queue stuck on a
 * database hiccup. The cost is that an action can succeed unaudited, so a
 * failure is logged loudly and the return value says so, leaving a caller that
 * genuinely cannot tolerate that (none today) free to check it.
 *
 * PREVIOUS AND NEW VALUES ARE BOTH ACCEPTED, per §21.2's "corrections create new
 * versions". An audit row that records only the new state cannot answer what
 * changed, which is the question the table exists for.
 */

export type AuditActorRole = "candidate" | "moderator" | "admin" | "system";

export interface AuditEventInput {
  /** Null for system-initiated actions; there is genuinely no human actor. */
  actorId?: string | null;
  actorRole: AuditActorRole;
  actorIp?: string | null;
  /** Dotted verb, e.g. 'moderation.decision.recorded'. */
  action: string;
  entityType: string;
  entityId?: string | null;
  /** One human-readable line. */
  summary: string;
  previousValues?: unknown;
  newValues?: unknown;
  reason?: string | null;
  correlationId?: string | null;
}

export interface AuditEventRecord {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  reason: string | null;
  previousValues: unknown;
  newValues: unknown;
}

export interface AuditWriteResult {
  recorded: boolean;
  error?: string;
}

export async function recordAuditEvent(
  client: SupabaseClient,
  input: AuditEventInput,
): Promise<AuditWriteResult> {
  // The WHOLE call is wrapped, not just the error field. A PostgREST query
  // builder can also THROW — a client without a from(), a transport failure, a
  // network rejection — and an earlier version of this function only inspected
  // the returned error, so those threw straight through into the caller's
  // request handler. That turned "best-effort audit logging" into "any audit
  // problem fails the action", which is the exact opposite of the documented
  // contract and was caught by the subscription-cancellation route test.
  let error: { message: string } | null = null;

  try {
    const result = await client.from("audit_events").insert({
      actor_id: input.actorId ?? null,
      actor_role: input.actorRole,
      actor_ip: input.actorIp ?? null,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      summary: input.summary,
      previous_values: input.previousValues ?? null,
      new_values: input.newValues ?? null,
      reason: input.reason ?? null,
      correlation_id: input.correlationId ?? null,
    });
    error = result.error ?? null;
  } catch (thrown) {
    error = { message: thrown instanceof Error ? thrown.message : String(thrown) };
  }

  if (error) {
    // Loud, because this is the one failure that is invisible by design.
    console.error("[audit] FAILED TO RECORD AUDIT EVENT", {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      error: error.message,
    });
    return { recorded: false, error: error.message };
  }

  return { recorded: true };
}

interface AuditRow {
  id: string;
  occurred_at: string;
  actor_id: string | null;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
  reason: string | null;
  previous_values: unknown;
  new_values: unknown;
}

export const DEFAULT_AUDIT_LIMIT = 100;
export const MAX_AUDIT_LIMIT = 500;

/** Clamped into range, defaulting rather than propagating a non-finite value into the query. */
export function clampAuditLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_AUDIT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_AUDIT_LIMIT);
}

export interface AuditEventList {
  events: AuditEventRecord[];
  /** The clamped page size actually applied. */
  limit: number;
  /** True when older rows exist beyond the window. */
  truncated: boolean;
}

/**
 * Newest first, bounded. Unbounded is not offered: audit_events is append-only,
 * so its row count only ever grows, and "return everything" would eventually be
 * a query that cannot finish.
 *
 * limit + 1 rows are fetched so "are there older rows?" is answered by the data
 * rather than inferred from a full page — a page that happens to be exactly full
 * is otherwise indistinguishable from the end of the table.
 */
export async function listAuditEvents(
  client: SupabaseClient,
  options: { limit?: number } = {},
): Promise<AuditEventList> {
  const limit = clampAuditLimit(options.limit);

  const { data, error } = await client
    .from("audit_events")
    .select("id, occurred_at, actor_id, actor_role, action, entity_type, entity_id, summary, reason, previous_values, new_values")
    .order("occurred_at", { ascending: false })
    .limit(limit + 1);

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as AuditRow[];

  return {
    events: rows.slice(0, limit).map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      summary: row.summary,
      reason: row.reason,
      previousValues: row.previous_values,
      newValues: row.new_values,
    })),
    limit,
    truncated: rows.length > limit,
  };
}
