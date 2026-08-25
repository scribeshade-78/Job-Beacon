import type { SupabaseClient } from "@supabase/supabase-js";

export const MAILBOX_PROVIDERS = ["gmail", "outlook"] as const;

export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

export const MAILBOX_CONNECTION_STATUSES = ["pending", "connected", "revoked", "error"] as const;

export type MailboxConnectionStatus = (typeof MAILBOX_CONNECTION_STATUSES)[number];

export interface MailboxConnection {
  id: string;
  provider: MailboxProvider;
  status: MailboxConnectionStatus;
  emailAddress: string | null;
  connectedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface MailboxConnectionRow {
  id: string;
  provider: MailboxProvider;
  status: MailboxConnectionStatus;
  email_address: string | null;
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
      .select("id, provider, status, email_address, connected_at, revoked_at, created_at")
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
        emailAddress: row.email_address,
        connectedAt: row.connected_at,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
      })),
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

/**
 * R6.1: mailbox_connections grants candidates SELECT only (see its
 * migration) — connecting/disconnecting completes via a server-side
 * Express route under service_role, same "server route, not a direct
 * Supabase call" shape as moderation.ts's getModerationQueue.
 */
export type StartMailboxConnectResult = { kind: "success"; authorizeUrl: string } | { kind: "error"; message: string };

const GENERIC_CONNECT_FAILURE_MESSAGE = "Could not start connecting your mailbox. Please try again.";

export async function startMailboxConnect(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StartMailboxConnectResult> {
  let response: Response;

  try {
    response = await fetchImpl("/api/mailbox/connect/start", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (!response.ok) {
    return { kind: "error", message: GENERIC_CONNECT_FAILURE_MESSAGE };
  }

  const body = (await response.json()) as { authorizeUrl: string };
  return { kind: "success", authorizeUrl: body.authorizeUrl };
}

const GENERIC_DISCONNECT_FAILURE_MESSAGE = "Could not disconnect this mailbox. Please try again.";

export type DisconnectMailboxResult = { kind: "success" } | { kind: "error"; message: string };

export async function disconnectMailboxConnection(
  connectionId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DisconnectMailboxResult> {
  let response: Response;

  try {
    response = await fetchImpl(`/api/mailbox/${connectionId}/disconnect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (!response.ok) {
    return { kind: "error", message: GENERIC_DISCONNECT_FAILURE_MESSAGE };
  }

  return { kind: "success" };
}
