import type { FetchImpl } from "./oauth.js";
import { parseMailboxAddress, formatMailbox } from "./mailAddress.js";
import { MailTransportError, type MailTransport, type OutboundEnvelope } from "./mailTransport.js";

/**
 * Resend, over plain fetch — no SDK, the same "a stable REST API does not need a client library"
 * convention as oauth.ts and gmailClient.ts.
 *
 * Idempotency-Key IS SENT AND IT MATTERS. Resend deduplicates on that header for 24 hours, which
 * is what makes a retry after an ambiguous network failure safe rather than a second email to an
 * employer. Verified against the published API reference, not assumed.
 */
export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export const RESEND_API_KEY_ENV = "RESEND_API_KEY";
export const OUTBOUND_MAIL_FROM_ENV = "OUTBOUND_MAIL_FROM";

export interface ResendTransportConfig {
  apiKey: string;
  fetchImpl?: FetchImpl;
  endpoint?: string;
}

export function createResendTransport(config: ResendTransportConfig): MailTransport {
  const apiKey = config.apiKey?.trim();
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = config.endpoint ?? RESEND_ENDPOINT;

  if (!apiKey) {
    throw new Error("Resend requires an API key.");
  }

  return {
    async send(envelope: OutboundEnvelope): Promise<{ providerMessageId: string }> {
      let response: Response;

      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + apiKey,
            "Content-Type": "application/json",
            "Idempotency-Key": envelope.idempotencyKey,
          },
          body: JSON.stringify({
            from: formatMailbox(envelope.from.name, envelope.from.address),
            to: [envelope.to],
            subject: envelope.subject,
            reply_to: envelope.replyTo,
            text: envelope.text,
          }),
        });
      } catch (error) {
        // AMBIGUOUS, NOT NECESSARILY FAILED: the request may have reached Resend. The idempotency
        // key is what makes retrying correct rather than duplicative.
        throw new MailTransportError(
          "Resend request failed before a response: " + (error instanceof Error ? error.message : String(error)),
          { retryable: true, ambiguous: true },
        );
      }

      const raw = await response.text();

      if (!response.ok) {
        // 429 and 5xx are the provider saying "later". Everything else is the provider saying
        // "no" — retrying a 422 just repeats the same rejection.
        const retryable = response.status === 429 || response.status >= 500;

        throw new MailTransportError(
          "Resend rejected the message with HTTP " + response.status + ": " + raw.slice(0, 300),
          { retryable, status: response.status },
        );
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }

      const id =
        parsed !== null && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "string"
          ? (parsed as { id: string }).id
          : null;

      if (!id) {
        // Accepted but unidentifiable. The email may well have been delivered, so claiming a
        // definitive failure would be a lie; the retry is safe because of the idempotency key.
        throw new MailTransportError("Resend accepted the request but returned no message id.", {
          retryable: true,
          ambiguous: true,
          status: response.status,
        });
      }

      return { providerMessageId: id };
    },
  };
}

export interface ResendConfig {
  apiKey: string;
  from: { name: string | null; address: string };
}

/**
 * Reads and validates the provider configuration.
 *
 * THROWS RATHER THAN GUESSING A SENDER. OUTBOUND_MAIL_FROM must be a single bare address: the
 * display name is per-message (the candidate's), so a name baked into this variable would either
 * be ignored or override it.
 */
export function readResendConfig(
  env: Record<string, string | undefined> = process.env,
): ResendConfig {
  const apiKey = env[RESEND_API_KEY_ENV];

  if (!apiKey) {
    throw new Error("Missing " + RESEND_API_KEY_ENV + " — required to send outbound email.");
  }

  const raw = env[OUTBOUND_MAIL_FROM_ENV];
  const from = parseMailboxAddress(raw);

  // BARE means bare. parseMailboxAddress would happily strip a display name, and silently
  // discarding a configured name is worse than refusing it: the operator would believe the
  // sender reads "JobBeacon" while the envelope actually uses the per-message candidate name.
  if (!from || (typeof raw === "string" && raw.trim() !== from)) {
    throw new Error(
      OUTBOUND_MAIL_FROM_ENV + " must be a single bare email address (for example notifications@jobbeacon.in).",
    );
  }

  return { apiKey, from: { name: null, address: from } };
}
