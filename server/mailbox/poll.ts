import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { fetchMessageMetadata, fetchMessagePlainText, listRecentMessageIds } from "./gmailClient.js";
import { classifyAndStoreMessage } from "./classifyBatch.js";
import {
  GoogleRefreshTokenInvalidError,
  refreshGoogleAccessToken,
  type FetchImpl,
  type GoogleOAuthConfig,
  type StoredMailboxTokenBundle,
} from "./oauth.js";
import { decryptMailboxSecret, encryptMailboxSecret } from "./tokenCrypto.js";

/** In-flight claim lock — long enough to cover one poll cycle; a crashed run is reclaimable after this without waiting for the next real interval. */
const LEASE_DURATION_MS = 2 * 60 * 1000;
/** Approved cadence (R6.2): also doubles as the "next eligible poll" time on both success and transient-backoff, so no separate cadence field is needed. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Approved cap: 5 consecutive transient failures flips the connection to 'error' and stops polling it until the candidate reconnects. */
const MAX_TRANSIENT_FAILURES = 5;
/** Refresh proactively rather than waiting for Gmail to reject an about-to-expire token. */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
/** Re-checks a window overlapping the last poll rather than exactly resuming at last_polled_at — tolerates clock skew and any gap between "polled" and "committed"; the messages unique constraint absorbs the resulting re-fetches as safe no-ops. */
const POLL_OVERLAP_BUFFER_MS = 60 * 60 * 1000;
/** First-ever poll for a newly connected mailbox has no last_polled_at to overlap from. */
const DEFAULT_FIRST_POLL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

interface ClaimedConnection {
  id: string;
  secret_manager_key: string | null;
  last_polled_at: string | null;
  poll_failure_count: number;
}

/**
 * Atomically claims every due `connected` Gmail connection via a single
 * UPDATE ... WHERE ... RETURNING (PostgREST executes update+select as one
 * statement) — no RPC/queue table needed, same "let the WHERE clause
 * decide" discipline reports.ts's trust-status demotion already uses. Two
 * overlapping cron-triggered runs can't double-claim the same row: once
 * one run's UPDATE commits, the row's polling_leased_until no longer
 * satisfies the other run's WHERE clause.
 */
export async function claimMailboxConnectionsForPolling(client: SupabaseClient): Promise<ClaimedConnection[]> {
  const nowIso = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + LEASE_DURATION_MS).toISOString();

  const { data, error } = await client
    .from("mailbox_connections")
    .update({ polling_leased_until: leaseUntil })
    .eq("status", "connected")
    .eq("provider", "gmail")
    .or(`polling_leased_until.is.null,polling_leased_until.lt.${nowIso}`)
    .select("id, secret_manager_key, last_polled_at, poll_failure_count");

  if (error) {
    throw error;
  }

  return (data ?? []) as ClaimedConnection[];
}

async function markTerminalError(client: SupabaseClient, connectionId: string, message: string): Promise<void> {
  const { error } = await client
    .from("mailbox_connections")
    .update({ status: "error", last_poll_error: message })
    .eq("id", connectionId);

  if (error) {
    // Nothing further to isolate this from — logged for visibility, the
    // connection stays 'connected' and gets reclaimed (and retried) next run.
    console.error("[mailbox:poll] failed to record terminal error", { connectionId, error });
  }
}

export interface PollConnectionResult {
  connectionId: string;
  messagesFetched: number;
  outcome: "success" | "transient_error" | "terminal_error";
  error?: string;
}

/**
 * Polls one already-claimed connection. Never throws — every failure path
 * (missing/corrupt credentials, invalid_grant, Gmail API errors, DB errors)
 * is caught and turned into a result + a best-effort status write, mirroring
 * runOneApplicationAttempt/runOneIngestionJob's "isolate per-item failures,
 * let the caller keep going" shape.
 */
export async function pollOneMailboxConnection(
  client: SupabaseClient,
  connection: ClaimedConnection,
  config: GoogleOAuthConfig,
  encryptionKey: Buffer,
  fetchImpl: FetchImpl = fetch,
  openaiClient?: Pick<OpenAI, "chat">,
): Promise<PollConnectionResult> {
  if (!connection.secret_manager_key) {
    // Shouldn't happen for a 'connected' row (completeMailboxConnect always
    // sets it), but a connection with nothing to decrypt can never be
    // polled — same terminal treatment as an invalid refresh token.
    const message = "Missing stored credentials.";
    await markTerminalError(client, connection.id, message);
    return { connectionId: connection.id, messagesFetched: 0, outcome: "terminal_error", error: message };
  }

  let bundle: StoredMailboxTokenBundle;

  try {
    bundle = JSON.parse(decryptMailboxSecret(encryptionKey, connection.secret_manager_key)) as StoredMailboxTokenBundle;
  } catch {
    const message = "Stored credentials could not be decrypted.";
    await markTerminalError(client, connection.id, message);
    return { connectionId: connection.id, messagesFetched: 0, outcome: "terminal_error", error: message };
  }

  try {
    let accessToken = bundle.accessToken;

    if (bundle.expiresAt <= Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
      const refreshed = await refreshGoogleAccessToken(config, bundle.refreshToken, fetchImpl);
      accessToken = refreshed.accessToken;
      bundle = { ...bundle, accessToken, expiresAt: refreshed.expiresAt };

      // Persisted before the Gmail fetch below: a crash after this point just
      // means one wasted extra refresh next run, never a lost/stale token.
      const { error: persistError } = await client
        .from("mailbox_connections")
        .update({ secret_manager_key: encryptMailboxSecret(encryptionKey, JSON.stringify(bundle)) })
        .eq("id", connection.id);

      if (persistError) {
        throw persistError;
      }
    }

    const lookbackFrom = connection.last_polled_at
      ? new Date(connection.last_polled_at).getTime() - POLL_OVERLAP_BUFFER_MS
      : Date.now() - DEFAULT_FIRST_POLL_LOOKBACK_MS;
    const sinceUnixSeconds = Math.floor(lookbackFrom / 1000);

    const messageIds = await listRecentMessageIds(accessToken, sinceUnixSeconds, fetchImpl);

    for (const messageId of messageIds) {
      const metadata = await fetchMessageMetadata(accessToken, messageId, fetchImpl);

      const { data: upserted, error: upsertError } = await client
        .from("messages")
        .upsert(
          {
            mailbox_connection_id: connection.id,
            provider_message_id: metadata.id,
            sender: metadata.sender,
            subject: metadata.subject,
            received_at: metadata.receivedAt,
            raw_payload: metadata.raw,
          },
          { onConflict: "mailbox_connection_id,provider_message_id" },
        )
        .select("id")
        .single();

      if (upsertError) {
        throw upsertError;
      }

      if (openaiClient && upserted) {
        // Best-effort Response Intelligence classification. It must never
        // fail or slow a poll — a message not classified here is picked up
        // later by runMessageClassificationBatch. Same "AI step isolated
        // from ingestion" stance as trust scoring in the ingestion worker.
        const messageDbId = (upserted as { id: string }).id;
        try {
          // The poll window overlaps the previous run by an hour, so most
          // messages seen here were already stored (and classified) on an
          // earlier pass — skip the paid model call when a classification
          // already exists.
          const { data: existing } = await client
            .from("response_classifications")
            .select("id")
            .eq("message_id", messageDbId)
            .maybeSingle();

          if (!existing) {
            const bodyText = await fetchMessagePlainText(accessToken, metadata.id, fetchImpl);
            await classifyAndStoreMessage(client, openaiClient, {
              messageId: messageDbId,
              sender: metadata.sender,
              subject: metadata.subject,
              bodyText,
            });
          }
        } catch (error) {
          console.error("[mailbox:poll] classification failed for a message", {
            connectionId: connection.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const { error: successError } = await client
      .from("mailbox_connections")
      .update({
        polling_leased_until: new Date(Date.now() + POLL_INTERVAL_MS).toISOString(),
        last_polled_at: new Date().toISOString(),
        last_poll_error: null,
        poll_failure_count: 0,
      })
      .eq("id", connection.id);

    if (successError) {
      throw successError;
    }

    return { connectionId: connection.id, messagesFetched: messageIds.length, outcome: "success" };
  } catch (error) {
    if (error instanceof GoogleRefreshTokenInvalidError) {
      await markTerminalError(client, connection.id, error.message);
      return { connectionId: connection.id, messagesFetched: 0, outcome: "terminal_error", error: error.message };
    }

    const message = error instanceof Error ? error.message : String(error);
    const failureCount = connection.poll_failure_count + 1;

    if (failureCount >= MAX_TRANSIENT_FAILURES) {
      await markTerminalError(client, connection.id, message);
      return { connectionId: connection.id, messagesFetched: 0, outcome: "terminal_error", error: message };
    }

    const { error: backoffError } = await client
      .from("mailbox_connections")
      .update({
        polling_leased_until: new Date(Date.now() + POLL_INTERVAL_MS).toISOString(),
        last_poll_error: message,
        poll_failure_count: failureCount,
      })
      .eq("id", connection.id);

    if (backoffError) {
      console.error("[mailbox:poll] failed to record backoff state", { connectionId: connection.id, error: backoffError });
    }

    return { connectionId: connection.id, messagesFetched: 0, outcome: "transient_error", error: message };
  }
}

export interface RunMailboxPollingBatchResult {
  claimed: number;
  succeeded: number;
  transientErrors: number;
  terminalErrors: number;
}

/**
 * R6.2 single-pass batch entrypoint: claim every due connection, poll each
 * in isolation, then return. Meant to be invoked once per process (see
 * cli.ts) and scheduled externally (cron) — same "no daemon loop" position
 * as runApplicationBatch/runOneIngestionJob.
 */
export async function runMailboxPollingBatch(
  client: SupabaseClient,
  config: GoogleOAuthConfig,
  encryptionKey: Buffer,
  fetchImpl: FetchImpl = fetch,
  openaiClient?: Pick<OpenAI, "chat">,
): Promise<RunMailboxPollingBatchResult> {
  const connections = await claimMailboxConnectionsForPolling(client);

  let succeeded = 0;
  let transientErrors = 0;
  let terminalErrors = 0;

  for (const connection of connections) {
    try {
      const result = await pollOneMailboxConnection(
        client,
        connection,
        config,
        encryptionKey,
        fetchImpl,
        openaiClient,
      );

      if (result.outcome === "success") {
        succeeded += 1;
      } else if (result.outcome === "transient_error") {
        transientErrors += 1;
      } else {
        terminalErrors += 1;
      }
    } catch (error) {
      console.error("[mailbox:poll] unexpected error polling connection", { connectionId: connection.id, error });
      transientErrors += 1;
    }
  }

  return { claimed: connections.length, succeeded, transientErrors, terminalErrors };
}
