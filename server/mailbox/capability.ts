import { readGoogleOAuthConfig } from "./oauth.js";
import { readMailboxEncryptionKey } from "./tokenCrypto.js";

/**
 * Task H2 — one place that answers "can this deployment do mailbox and calendar
 * work, and if not, why not".
 *
 * WHY THIS EXISTS. readGoogleOAuthConfig() and readMailboxEncryptionKey() both
 * THROW when their environment is incomplete, which is the right behaviour the
 * moment a route needs them: a mailbox connect that cannot build an authorize
 * URL must fail loudly rather than half-work. But it is the wrong behaviour for
 * a long-running background process, where the same throw at startup takes down
 * the whole scheduler — and, on the server path, turns an optional feature into
 * an outage. The gap this closes is specifically that mailbox and calendar are
 * OPTIONAL capabilities of a product whose other half (discovery, trust,
 * applications, fit analysis, follow-ups) does not need Google at all.
 *
 * SO NOTHING HERE THROWS. The readers are called inside a try, and the message
 * they would have thrown with is reused verbatim as the reason — the same
 * sentence an operator would have seen from a failed route, rather than a second
 * wording that could disagree with it.
 *
 * THE CALLER DECIDES WHAT TO DO, and the two callers decide differently:
 *   - server/scheduler.ts logs the reasons once and simply does not register the
 *     Google-dependent tasks, so everything else keeps running.
 *   - a request-time path can keep letting the reader throw, because there the
 *     failure belongs to that one request.
 */

export interface SubsystemStatus {
  enabled: boolean;
  /** The reader's own message when disabled; null when enabled. */
  reason: string | null;
}

export interface MailboxCapability {
  /** Gmail polling. Needs both the OAuth client and the token key. */
  googleMail: SubsystemStatus;
  /** Google Calendar sync. Same two requirements, plus a per-connection scope check at run time. */
  googleCalendar: SubsystemStatus;
  /** Encrypting and decrypting stored OAuth tokens. */
  tokenEncryption: SubsystemStatus;
  /** The OAuth client itself, reported separately so the reason names the right missing thing. */
  googleOAuth: SubsystemStatus;
}

function probe(read: () => unknown): SubsystemStatus {
  try {
    read();
    return { enabled: true, reason: null };
  } catch (error) {
    return { enabled: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function readMailboxCapability(env: Record<string, string | undefined> = process.env): MailboxCapability {
  const googleOAuth = probe(() => readGoogleOAuthConfig(env));
  const tokenEncryption = probe(() => readMailboxEncryptionKey(env));
  const googleReady = googleOAuth.enabled && tokenEncryption.enabled;

  return {
    googleOAuth,
    tokenEncryption,
    googleMail: {
      enabled: googleReady,
      // Naming the FIRST missing prerequisite, so an operator fixing one thing
      // at a time is not told about the second until the first is done.
      reason: googleReady ? null : googleOAuth.reason ?? tokenEncryption.reason,
    },
    googleCalendar: {
      enabled: googleReady,
      reason: googleReady ? null : googleOAuth.reason ?? tokenEncryption.reason,
    },
  };
}

/**
 * Human-readable warning lines for a startup log, empty when everything is
 * configured. Returned as lines rather than logged here so the module stays
 * testable and the scheduler decides how loud to be.
 */
export function describeMailboxCapability(capability: MailboxCapability): string[] {
  const lines: string[] = [];

  if (!capability.googleMail.enabled) {
    lines.push(
      "Mailbox polling and Google Calendar sync are DISABLED: " +
        (capability.googleMail.reason ?? "Google credentials are not configured") +
        " Message classification and application matching still run over anything already stored.",
    );
  }

  return lines;
}
