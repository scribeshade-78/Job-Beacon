/**
 * The seam between "decide to send" and "a provider transmits".
 *
 * WHY AN INTERFACE AND NOT A PROVIDER CALL INLINE. Every failure mode that matters here —
 * a definitive rejection, a retryable outage, and an ambiguous timeout — has to be classifiable
 * by the caller BEFORE it decides whether to write 'sent', leave the row claimed, or hand the
 * draft back to the candidate. A transport that only throws strings makes that impossible, and
 * a test cannot assert an envelope it never sees.
 */
export interface OutboundEnvelope {
  from: { name: string | null; address: string };
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  /** Stable per message; the provider dedupes on it, so a retry after an ambiguous failure is safe. */
  idempotencyKey: string;
}

export interface MailTransport {
  send(envelope: OutboundEnvelope): Promise<{ providerMessageId: string }>;
}

/**
 * A delivery failure, classified by whether a retry can duplicate an email.
 *
 * RETRYABLE IS NOT "THE ERROR LOOKED TRANSIENT" — it means a retry cannot send a second copy,
 * because the provider deduplicates on the idempotency key. That is why an ambiguous timeout is
 * retryable and a 422 is not.
 */
export class MailTransportError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = "MailTransportError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}
