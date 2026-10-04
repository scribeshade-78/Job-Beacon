/**
 * Task H3 — how an ATS submission failure is described, so the worker can tell
 * a rate limit from a validation rejection.
 *
 * PRD v3 §16.2 requires the authorized-ATS channel to "handle validation/rate
 * limits", and the two need opposite responses:
 *
 *   - A RATE LIMIT (HTTP 429, or 5xx) is temporary. The correct action is to
 *     back off and retry, and Lever's own documentation is blunt about it:
 *     "Application create requests are rate limited. Your team will need to
 *     properly handle 429 responses."
 *   - A VALIDATION REJECTION (most 4xx) is permanent. The form refused what we
 *     sent, and sending it again changes nothing. Retrying it four times by
 *     exponential backoff wastes an employer's API budget and delays the
 *     candidate being told their application needs attention.
 *
 * Before this, every adapter failure was a bare Error and the worker could not
 * tell them apart, so it retried both.
 */
export class AtsSubmissionError extends Error {
  readonly retryable: boolean;
  /** The HTTP status, when the failure was one. */
  readonly status: number | null;
  /** Seconds the provider asked us to wait, when it said. */
  readonly retryAfterSeconds: number | null;
  readonly reasonCode: string;

  /**
   * WHETHER THE ADAPTER HAS ESTABLISHED THAT THE PORTAL DID NOT ACCEPT THE
   * SUBMISSION. Defaults to false, and false means "unknown", so the attempt is
   * not resubmitted automatically.
   *
   * retryable is NOT this: it says retrying might help, not that nothing was
   * accepted. An adapter that saw a 502 after the request was sent cannot set
   * this; one that failed validation before sending can.
   */
  readonly nonAcceptanceEstablished: boolean;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      reasonCode: string;
      status?: number | null;
      retryAfterSeconds?: number | null;
      /** True ONLY when the adapter knows the portal did not accept this submission. */
      nonAcceptanceEstablished?: boolean;
    },
  ) {
    super(message);
    this.name = "AtsSubmissionError";
    this.retryable = options.retryable;
    this.nonAcceptanceEstablished = options.nonAcceptanceEstablished ?? false;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.reasonCode = options.reasonCode;
  }
}

/**
 * Reads Retry-After, which may be either delta-seconds or an HTTP date.
 * Returns null rather than a guess when it is absent or unparseable: inventing
 * a wait would be attributing a value to the provider that it never sent.
 */
export function retryAfterSecondsFrom(response: Response): number | null {
  const header = response.headers?.get?.("retry-after");
  if (!header) {
    return null;
  }

  const asNumber = Number.parseInt(header, 10);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return asNumber;
  }

  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    const seconds = Math.round((asDate - Date.now()) / 1000);
    return seconds > 0 ? seconds : 0;
  }

  return null;
}

/**
 * Classifies a non-2xx ATS response. 429 and 5xx are retryable; every other 4xx
 * is a validation rejection and is terminal for this attempt.
 */
export function atsHttpFailure(
  response: Response,
  detail: string,
  reasonCode: string,
): AtsSubmissionError {
  const retryable = response.status === 429 || response.status >= 500;
  const retryAfterSeconds = retryable ? retryAfterSecondsFrom(response) : null;

  const suffix = retryAfterSeconds === null ? "" : " (provider asked to wait " + retryAfterSeconds + "s)";

  return new AtsSubmissionError(reasonCode + ": " + detail + suffix, {
    retryable,
    reasonCode,
    status: response.status,
    retryAfterSeconds,
  });
}
