import type { SupabaseClient } from "@supabase/supabase-js";

export const MAILBOX_PROVIDERS = ["gmail", "outlook"] as const;

export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

export const MAILBOX_CONNECTION_STATUSES = ["pending", "connected", "revoked", "error"] as const;

export type MailboxConnectionStatus = (typeof MAILBOX_CONNECTION_STATUSES)[number];

export interface MailboxConnection {
  id: string;
  provider: MailboxProvider;
  status: MailboxConnectionStatus;
  connectedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface MailboxConnectionRow {
  id: string;
  provider: MailboxProvider;
  status: MailboxConnectionStatus;
  connected_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const GENERIC_FAILURE_MESSAGE = "Could not load your mailbox connections. Please try again.";

export type ListMailboxConnectionsResult =
  | { kind: "success"; connections: MailboxConnection[] }
  | { kind: "error"; message: string };

/**
 * Reads the caller's own mailbox_connections via RLS
 * (mailbox_connections_select_own scopes rows to auth.uid() = candidate_id)
 * — no OAuth flow exists anywhere in this repository yet (R6.1), so this
 * will almost always resolve to an empty list; MailboxPanel renders that
 * honestly rather than implying a "Connect" action that goes nowhere.
 */
export async function listMailboxConnections(
  client: Pick<SupabaseClient, "from">,
): Promise<ListMailboxConnectionsResult> {
  try {
    const { data, error } = await client
      .from("mailbox_connections")
      .select("id, provider, status, connected_at, revoked_at, created_at")
      .order("created_at", { ascending: false });

    if (error || !data) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    const rows = data as unknown as MailboxConnectionRow[];

    return {
      kind: "success",
      connections: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        status: row.status,
        connectedAt: row.connected_at,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
      })),
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}
