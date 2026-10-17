import { createHash } from "node:crypto";
import { parseMailboxAddress } from "./mailAddress.js";
import { mintReplyAddress } from "./replyToken.js";
import type { OutboundEnvelope } from "./mailTransport.js";

/**
 * Builds the exact message a follow-up send will transmit.
 *
 * THE REPLY-TO IS THE WHOLE POINT. It is the candidate's own address with the attempt's token
 * appended, so the employer's reply lands in the mailbox we already poll and carries a MAC that
 * resolves to this application. Phase 17 built that token; this is its first real caller.
 *
 * THE FROM IS OURS AND SAYS SO. We cannot authenticate as the candidate — we hold gmail.readonly,
 * and no arrangement of headers would DKIM-align a gmail.com sender. "Jane Doe via JobBeacon"
 * is the honest description of who is writing: us, on their instruction.
 */

export const BRAND_NAME = "JobBeacon";

/** Raised when the candidate's address plus a token cannot fit in a 64-octet local part. */
export class ReplyAddressUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyAddressUnavailableError";
  }
}

export interface FollowUpEnvelopeInput {
  /** The attempt the reply must resolve back to. */
  attemptId: string;
  /** An address parsed out of messages.sender — never user input. */
  to: string;
  subject: string;
  text: string;
  /** From a confirmed full_name fact, or null. */
  candidateName: string | null;
  /** mailbox_connections.email_address — what the token is appended to. */
  candidateAddress: string;
  /** notifications@jobbeacon.in — an address on the domain we authenticate. */
  fromAddress: string;
  replyTokenSecret: Buffer;
  /** The draft id: unique per message, and what the provider deduplicates on. */
  idempotencyKey: string;
}

export interface BuiltFollowUp {
  envelope: OutboundEnvelope;
  /** Stored on the draft so a reply can be traced back to this send. */
  replyAddress: string;
  /** sha256 of the exact body, so the record cannot drift from what was approved. */
  bodySha256: string;
}

export function buildFollowUpEnvelope(input: FollowUpEnvelopeInput): BuiltFollowUp {
  const to = parseMailboxAddress(input.to);

  if (!to) {
    throw new Error("A follow-up needs exactly one valid recipient address; received: " + JSON.stringify(input.to));
  }

  const fromAddress = parseMailboxAddress(input.fromAddress);

  if (!fromAddress) {
    throw new Error("The configured sender is not a single valid address: " + JSON.stringify(input.fromAddress));
  }

  const subject = input.subject.trim();

  // A subject is a header. A line break in one turns the rest into a new header, which is header
  // injection — the same reason the address parser refuses whitespace.
  if (subject === "" || /[\r\n]/.test(subject)) {
    throw new Error("A follow-up subject must be a single non-empty line.");
  }

  if (input.text.trim() === "") {
    throw new Error("A follow-up body must not be empty.");
  }

  const idempotencyKey = input.idempotencyKey.trim();

  if (idempotencyKey === "") {
    throw new Error("A follow-up needs an idempotency key (the draft id).");
  }

  const replyAddress = mintReplyAddress(input.attemptId, {
    secret: input.replyTokenSecret,
    baseAddress: input.candidateAddress,
  });

  if (replyAddress === null) {
    throw new ReplyAddressUnavailableError(
      "The candidate's address plus a reply token exceeds the 64-octet local-part limit, so a reply could not be attributed.",
    );
  }

  const candidateName = input.candidateName?.trim() ?? "";
  const displayName = candidateName === "" ? BRAND_NAME : candidateName + " via " + BRAND_NAME;

  return {
    envelope: {
      from: { name: displayName, address: fromAddress },
      to,
      replyTo: replyAddress,
      subject,
      text: input.text,
      idempotencyKey,
    },
    replyAddress,
    bodySha256: createHash("sha256").update(input.text, "utf8").digest("hex"),
  };
}
