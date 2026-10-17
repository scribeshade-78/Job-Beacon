import type { SupabaseClient } from "@supabase/supabase-js";
import { buildFollowUpEnvelope } from "./followUpEnvelope.js";
import { parseMailboxAddress } from "./mailAddress.js";
import { MailTransportError, type MailTransport } from "./mailTransport.js";
import {
  FollowUpDeliveryUnconfirmedError,
  FollowUpMailboxUnavailableError,
  FollowUpNotAuthorizedError,
  FollowUpNotClaimableError,
  FollowUpRecipientUnavailableError,
  FollowUpSendRejectedError,
} from "./followUpErrors.js";

/**
 * THE SEND, AS A CLAIM-AND-SETTLE STATE MACHINE.
 *
 * pending_review --CAS--> sending --accepted--> sent
 *                          |
 *                          +--definitive rejection--> pending_review (+ last_send_error)
 *                          +--no answer-------------> stays sending, recovered by a sweep
 *
 * WHY THE CLAIM EXISTS. Sending is irreversible. Without it, two concurrent approvals both call
 * the provider and the employer gets the same follow-up twice. The CAS is a single UPDATE whose
 * WHERE clause names the state it is moving out of, so exactly one caller can win.
 *
 * WHY AN AMBIGUOUS FAILURE STAYS CLAIMED. If the answer never arrived, the email may already be in
 * the employer's inbox. Reverting to pending_review would invite a second send; marking it sent
 * would be a lie. The row stays claimed, carries the reason, and the sweep hands it to a human.
 */

/** How long a claim may sit unfinished before the sweep treats it as orphaned. */
export const STUCK_SEND_THRESHOLD_MS = 10 * 60 * 1000;

/** Written onto a recovered row: the one thing the candidate needs to know before retrying. */
export const UNCONFIRMED_DELIVERY_NOTE =
  "The send was interrupted before the provider's answer was recorded, so delivery is unconfirmed. " +
  "Approving again is safe for 24 hours: the provider deduplicates on this draft's idempotency key.";

export interface FollowUpDispatchDeps {
  transport: MailTransport;
  from: { name: string | null; address: string };
  replyTokenSecret: Buffer;
  now?: () => number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

/** What the caller already proved ownership of, and what it is allowed to send. */
export interface DispatchableDraft {
  draftId: string;
  candidateId: string;
  applicationAttemptId: string;
  subject: string;
  text: string;
  /** Read before the claim, so the increment is not lost to a read-modify-write race. */
  sendAttempts: number;
}

export interface FollowUpDispatchResult {
  draftId: string;
  providerMessageId: string;
  recipient: string;
  replyAddress: string;
  sentAt: string;
}

export async function dispatchFollowUp(
  client: SupabaseClient,
  draft: DispatchableDraft,
  deps: FollowUpDispatchDeps,
): Promise<FollowUpDispatchResult> {
  const nowMs = (deps.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  // ---- consent, before anything is read that could be mistaken for permission ----
  const { data: authorization, error: authorizationError } = await client
    .from("automation_authorizations")
    .select("status, consent_version")
    .eq("candidate_id", draft.candidateId)
    .maybeSingle();

  if (authorizationError) {
    throw authorizationError;
  }

  const authorizationRow = authorization as { status: string; consent_version: string } | null;

  if (!authorizationRow || authorizationRow.status !== "authorized") {
    throw new FollowUpNotAuthorizedError(authorizationRow?.status ?? null);
  }

  // ---- the address the reply token is appended to ----
  const { data: mailbox, error: mailboxError } = await client
    .from("mailbox_connections")
    .select("email_address")
    .eq("candidate_id", draft.candidateId)
    .eq("provider", "gmail")
    .eq("status", "connected")
    .not("email_address", "is", null)
    .order("connected_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (mailboxError) {
    throw mailboxError;
  }

  const candidateAddress = (mailbox as { email_address: string } | null)?.email_address ?? null;

  if (!candidateAddress) {
    throw new FollowUpMailboxUnavailableError();
  }

  // ---- the recipient: ONLY an address the employer wrote FROM ----
  const { data: messages, error: messagesError } = await client
    .from("messages")
    .select("id, sender")
    .eq("application_attempt_id", draft.applicationAttemptId)
    .not("sender", "is", null)
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(20);

  if (messagesError) {
    throw messagesError;
  }

  let recipient: string | null = null;
  let recipientMessageId: string | null = null;

  for (const row of (messages ?? []) as Array<{ id: string; sender: string | null }>) {
    const parsed = parseMailboxAddress(row.sender);

    if (parsed) {
      recipient = parsed;
      recipientMessageId = row.id;
      break;
    }
  }

  if (!recipient || !recipientMessageId) {
    throw new FollowUpRecipientUnavailableError(draft.applicationAttemptId);
  }

  // ---- the display name, best effort: the brand alone is honest when there is none ----
  const { data: nameFact } = await client
    .from("extracted_facts")
    .select("fact_value")
    .eq("candidate_id", draft.candidateId)
    .eq("fact_type", "full_name")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const candidateName = (nameFact as { fact_value: string } | null)?.fact_value ?? null;

  // Built BEFORE the claim: a validation failure must never leave a claimed row behind.
  const built = buildFollowUpEnvelope({
    attemptId: draft.applicationAttemptId,
    to: recipient,
    subject: draft.subject,
    text: draft.text,
    candidateName,
    candidateAddress,
    fromAddress: deps.from.address,
    replyTokenSecret: deps.replyTokenSecret,
    idempotencyKey: draft.draftId,
  });

  // ---- claim ----
  const { data: claimed, error: claimError } = await client
    .from("follow_up_drafts")
    .update({
      status: "sending",
      sending_started_at: nowIso,
      send_attempts: draft.sendAttempts + 1,
      last_send_error: null,
    })
    .eq("id", draft.draftId)
    .eq("status", "pending_review")
    .select("id");

  if (claimError) {
    throw claimError;
  }

  if (!claimed || claimed.length === 0) {
    throw new FollowUpNotClaimableError(draft.draftId);
  }

  // ---- deliver ----
  let providerMessageId: string;

  try {
    const sent = await deps.transport.send(built.envelope);
    providerMessageId = sent.providerMessageId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof MailTransportError && error.ambiguous) {
      // The email may already be out. Keep the claim; the sweep asks a human.
      await client
        .from("follow_up_drafts")
        .update({ last_send_error: message })
        .eq("id", draft.draftId)
        .eq("status", "sending");

      throw new FollowUpDeliveryUnconfirmedError(message);
    }

    const { error: revertError } = await client
      .from("follow_up_drafts")
      .update({ status: "pending_review", sending_started_at: null, last_send_error: message })
      .eq("id", draft.draftId)
      .eq("status", "sending");

    if (revertError) {
      throw revertError;
    }

    throw new FollowUpSendRejectedError(message);
  }

  // ---- settle ----
  const { data: settled, error: settleError } = await client
    .from("follow_up_drafts")
    .update({
      status: "sent",
      sent_at: nowIso,
      approved_at: nowIso,
      provider_message_id: providerMessageId,
      recipient_address: built.envelope.to,
      recipient_message_id: recipientMessageId,
      reply_address: built.replyAddress,
      body_sha256: built.bodySha256,
      consent_version: authorizationRow.consent_version,
      last_send_error: null,
    })
    .eq("id", draft.draftId)
    .eq("status", "sending")
    .select("id");

  if (settleError) {
    throw settleError;
  }

  if (!settled || settled.length === 0) {
    // The provider accepted it but the row moved underneath us. Nothing safe to do automatically:
    // the email is out, and the idempotency key makes a re-approval a no-op for 24 hours.
    deps.log?.("follow-up accepted but not settled", { draftId: draft.draftId, providerMessageId });
    throw new Error("The email was accepted by the provider but the draft could not be marked sent.");
  }

  return {
    draftId: draft.draftId,
    providerMessageId,
    recipient: built.envelope.to,
    replyAddress: built.replyAddress,
    sentAt: nowIso,
  };
}

/**
 * Returns orphaned claims to review.
 *
 * THIS IS A HUMAN HAND-OFF, NOT A RETRY. The row may describe an email that was delivered, so
 * flipping it back to pending_review with a note is the honest move: the candidate decides, and
 * the provider's idempotency window makes that decision safe for a day.
 */
export async function recoverStuckFollowUpSends(
  client: SupabaseClient,
  options: { olderThanMs?: number; now?: () => number; limit?: number } = {},
): Promise<{ scanned: number; recovered: number }> {
  const nowMs = (options.now ?? Date.now)();
  const cutoff = new Date(nowMs - (options.olderThanMs ?? STUCK_SEND_THRESHOLD_MS)).toISOString();

  const { data: stuck, error } = await client
    .from("follow_up_drafts")
    .select("id")
    .eq("status", "sending")
    .lt("sending_started_at", cutoff)
    .limit(options.limit ?? 50);

  if (error) {
    throw error;
  }

  let recovered = 0;

  for (const row of (stuck ?? []) as Array<{ id: string }>) {
    const { data: updated, error: updateError } = await client
      .from("follow_up_drafts")
      .update({ status: "pending_review", sending_started_at: null, last_send_error: UNCONFIRMED_DELIVERY_NOTE })
      .eq("id", row.id)
      .eq("status", "sending")
      .select("id");

    if (updateError) {
      throw updateError;
    }

    if ((updated ?? []).length > 0) {
      recovered += 1;
    }
  }

  return { scanned: (stuck ?? []).length, recovered };
}
