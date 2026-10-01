/**
 * Client for GET /api/opportunities/capability — whether automatic application
 * can run at all, plus the pure copy/label logic the two surfaces share.
 *
 * WHY THE COPY LIVES HERE, NOT IN THE COMPONENTS. The bulk button on
 * Opportunities and the automation card on Home must never disagree about what
 * the system can do, and both need the same three-way distinction below. Pure
 * functions can be tested without a renderer, which is how every other client
 * module in this repository is tested.
 */

export interface QueueCapabilityPayload {
  canQueue: boolean;
  explanation: string;
}

/**
 * THREE STATES, NOT TWO. "We know it is unavailable" and "we could not find out"
 * are different answers, and collapsing them would let a network blip tell a
 * candidate that no source supports automation — a claim about the product that
 * a failed fetch cannot justify.
 */
export type QueueCapabilityState =
  | { kind: "loading" }
  | { kind: "ready"; canQueue: boolean; explanation: string }
  | { kind: "error"; message: string };

export const CAPABILITY_CHECK_FAILED =
  "Automatic submission status couldn't be checked. Retry";

const GENERIC_FAILURE = "Automatic submission status couldn't be checked. Retry";

/**
 * Reads the capability. Requires a token; a missing one is reported as an error
 * rather than assumed unavailable, for the same reason as above.
 */
async function defaultGetAccessToken(): Promise<string | null> {
  const { getSupabaseBrowserClient } = await import("./supabaseClient");
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

export interface FetchQueueCapabilityDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string | null>;
}

export async function fetchQueueCapability(
  deps: FetchQueueCapabilityDeps = {},
): Promise<QueueCapabilityState> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;

  let accessToken: string | null;

  try {
    accessToken = await getAccessToken();
  } catch {
    return { kind: "error", message: GENERIC_FAILURE };
  }

  if (!accessToken) {
    return { kind: "error", message: GENERIC_FAILURE };
  }

  let response: Response;

  try {
    response = await fetchImpl("/api/opportunities/capability", {
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken },
    });
  } catch {
    return { kind: "error", message: GENERIC_FAILURE };
  }

  if (!response.ok) {
    return { kind: "error", message: GENERIC_FAILURE };
  }

  try {
    const body = (await response.json()) as { canQueue?: unknown; explanation?: unknown };

    if (typeof body.canQueue !== "boolean") {
      return { kind: "error", message: GENERIC_FAILURE };
    }

    return {
      kind: "ready",
      canQueue: body.canQueue,
      explanation:
        typeof body.explanation === "string" && body.explanation.trim() !== ""
          ? body.explanation
          : body.canQueue
            ? "Automatic applications are available."
            : "Automatic submission unavailable — no available job source supports it yet.",
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE };
  }
}

export interface BulkApplyButtonState {
  label: string;
  disabled: boolean;
  /** Shown inline beneath the button; null when there is nothing to explain. */
  notice: string | null;
  /** True when the click must not issue a request. */
  blocked: boolean;
}

/**
 * The bulk action's label, availability and explanation.
 *
 * THE LABEL NEVER SAYS "APPLY TO N MATCHES". Two separate reasons:
 *   1. With no capable source it promised an action that cannot happen.
 *   2. Even with one, source capability says nothing about whether each visible
 *      job passes its OWN gates (trust status, role match, consent, the daily
 *      cap), so "apply to 25" would still overstate what a click achieves.
 * "Queue eligible applications" describes exactly what the server attempts, and
 * "queued" is never reported as "submitted" anywhere in this module.
 */
export function describeBulkApplyButton(input: {
  capability: QueueCapabilityState;
  visibleCount: number;
  busy: boolean;
}): BulkApplyButtonState {
  const { capability, visibleCount, busy } = input;

  if (capability.kind === "loading") {
    return { label: "Checking availability…", disabled: true, notice: null, blocked: true };
  }

  if (capability.kind === "error") {
    // NOT "sources are unavailable" — we do not know that, and saying it would
    // blame the product for a failed request. The retry lives with the notice.
    return { label: "Queue eligible applications", disabled: true, notice: capability.message, blocked: true };
  }

  if (!capability.canQueue) {
    return {
      label: "Queue eligible applications",
      disabled: true,
      notice: capability.explanation,
      blocked: true,
    };
  }

  if (visibleCount === 0) {
    return {
      label: "Queue eligible applications",
      disabled: true,
      notice: null,
      blocked: true,
    };
  }

  return {
    label: busy ? "Queueing…" : "Queue eligible applications",
    disabled: busy,
    notice: null,
    blocked: busy,
  };
}

/**
 * The count is shown SEPARATELY from the button, because it describes the loaded
 * list rather than what the action will do. Folding it into the label is what
 * made "Apply to 25 loaded matches" read as a promise.
 */
export function describeLoadedCount(visibleCount: number): string {
  if (visibleCount === 0) {
    return "No jobs loaded";
  }

  return visibleCount === 1 ? "1 loaded job" : visibleCount + " loaded jobs";
}

/**
 * The Home automation card's notice. Separate from the authorization badge,
 * which reports consent only.
 *
 * The wording is deliberate: it states what cannot run, why, and that the
 * candidate's authorization was NOT lost — otherwise "Authorized" beside a
 * "can't run" notice reads as a contradiction or as lost consent.
 */
export function describeAutomationCapabilityNotice(capability: QueueCapabilityState): string | null {
  if (capability.kind === "loading") {
    return null;
  }

  if (capability.kind === "error") {
    return CAPABILITY_CHECK_FAILED;
  }

  if (capability.canQueue) {
    return null;
  }

  return (
    "Automatic submission unavailable: no available job source supports queueing. " +
    "Your submission consent is saved and will apply once one does."
  );
}
