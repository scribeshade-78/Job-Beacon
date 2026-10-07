import type { ToastTone } from "../components/ui/toast";

/**
 * Client for POST /api/opportunities/bulk-apply — the "Apply to X loaded
 * matches" button on the Opportunities page.
 *
 * An Express call rather than a direct Supabase write because enqueuing runs
 * the eligibility gates through planApplication, which is server-side
 * privileged work (see server/applications/bulkApply.ts for why the gates are
 * not bypassed).
 */

export interface BlockingGate {
  gate: string;
  reasonCode: string | null;
}

export interface BulkApplyOutcome {
  vacancyId: string;
  status: "queued" | "blocked" | "error";
  blockingGates: BlockingGate[];
  error?: string;
}

export interface BulkApplyResult {
  requested: number;
  queued: number;
  blocked: number;
  errors: number;
  outcomes: BulkApplyOutcome[];
}

export type SubmitBulkApplyResult =
  | { kind: "success"; result: BulkApplyResult }
  | { kind: "error"; message: string };

export interface SubmitBulkApplyDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string | null>;
}

const GENERIC_FAILURE = "Could not queue applications. Please try again.";
const SESSION_EXPIRED = "Your session has expired. Please sign in again.";

async function defaultGetAccessToken(): Promise<string | null> {
  const { getSupabaseBrowserClient } = await import("./supabaseClient");
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

export async function submitBulkApply(
  vacancyIds: readonly string[],
  deps: SubmitBulkApplyDeps = {},
): Promise<SubmitBulkApplyResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;

  let accessToken: string | null;
  try {
    accessToken = await getAccessToken();
  } catch {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  if (!accessToken) {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  let response: Response;
  try {
    response = await fetchImpl("/api/opportunities/bulk-apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ vacancyIds }),
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (response.status === 401) {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  if (response.status === 429) {
    return { kind: "error", message: "You're applying too quickly. Please wait a few minutes." };
  }

  // 409 means the account is not set up yet, and the server names which step is
  // missing. Reporting the generic failure here would bury the one actionable
  // part, so the server's own sentence is preferred when it supplies one.
  if (response.status === 409) {
    let message = "Finish setting up your account before queueing applications.";

    try {
      const body = (await response.json()) as { error?: unknown; blockers?: Array<{ message?: unknown }> };
      const firstBlocker = Array.isArray(body.blockers) ? body.blockers[0]?.message : null;

      if (typeof firstBlocker === "string" && firstBlocker.trim() !== "") {
        message = firstBlocker;
      } else if (typeof body.error === "string" && body.error.trim() !== "") {
        message = body.error;
      }
    } catch {
      // Keep the default sentence.
    }

    return { kind: "error", message };
  }

  if (!response.ok) {
    return { kind: "error", message: GENERIC_FAILURE };
  }

  try {
    return { kind: "success", result: (await response.json()) as BulkApplyResult };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE };
  }
}

/**
 * The one reason worth naming outright. With no adapter registered for any
 * source (server/applications/adapters/registry.ts resolves every source_code
 * to unsupportedAdapter), application_support fails for every vacancy, and
 * "0 queued" is then the correct, expected state — not a malfunction. Saying
 * so plainly is the difference between an honest empty result and a button
 * that looks broken.
 */
const NO_ADAPTER_REASON = "NO_ADAPTER_REGISTERED_FOR_SOURCE";

function everyBlockedByMissingAdapter(result: BulkApplyResult): boolean {
  const blocked = result.outcomes.filter((outcome) => outcome.status === "blocked");

  return (
    blocked.length > 0 &&
    blocked.every((outcome) =>
      outcome.blockingGates.some(
        (gate) => gate.gate === "application_support" && gate.reasonCode === NO_ADAPTER_REASON,
      ),
    )
  );
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

export function describeBulkApplyResult(result: BulkApplyResult): { text: string; tone: ToastTone } {
  if (result.queued > 0) {
    const parts = [
      `Successfully queued ${result.queued} ${plural(result.queued, "application", "applications")}.`,
    ];

    if (result.blocked > 0) {
      parts.push(`${result.blocked} blocked by safety gates.`);
    }
    if (result.errors > 0) {
      parts.push(`${result.errors} could not be processed.`);
    }

    // An error alongside successes is still a partial success, not a failure.
    return { text: parts.join(" "), tone: result.errors > 0 ? "default" : "success" };
  }

  if (everyBlockedByMissingAdapter(result)) {
    return { text: "0 queued — no source supports automated submission yet.", tone: "default" };
  }

  if (result.errors > 0 && result.blocked === 0) {
    return {
      text: `Could not queue any applications. ${result.errors} ${plural(result.errors, "vacancy", "vacancies")} failed.`,
      tone: "error",
    };
  }

  if (result.blocked > 0) {
    return {
      text: `0 queued. ${result.blocked} ${plural(result.blocked, "application was", "applications were")} blocked by safety gates.`,
      tone: "default",
    };
  }

  return { text: "Nothing to queue.", tone: "default" };
}

/**
 * A blocking gate the candidate can actually clear.
 *
 * WHICH GATES QUALIFY. A gate reason is worth an interruption only when the fix
 * lives on a screen the candidate controls: plan_entitlement needs a paid plan,
 * location needs a stated search location. Everything else in the ledger is
 * either not theirs to fix (application_support — no adapter exists for that
 * source), already stated plainly by describeBulkApplyResult, or a deliberate
 * candidate decision that must not be shortcut (automation_authorization —
 * consent).
 */
export interface ActionableBlocker {
  gate: string;
  reasonCode: string | null;
  title: string;
  body: string;
  ctaLabel: string;
  /** A hash route ("/billing"), not a URL: this only ever navigates in-app. */
  ctaHref: string;
}

const ACTIONABLE_BLOCKERS: Record<string, Omit<ActionableBlocker, "gate" | "reasonCode">> = {
  plan_entitlement: {
    title: "Automatic applications need a paid plan",
    body:
      "Your current plan includes no automatic applications, so nothing was queued. " +
      "Searching, tailoring and tracking applications work on every plan, including Free.",
    ctaLabel: "See plans",
    ctaHref: "/billing",
  },
  location: {
    title: "Tell us where you want to work",
    body:
      "Your profile has no work location, so we cannot tell which of these jobs you are " +
      "eligible for. Add a country or city, or tick \u201copen to anywhere\u201d.",
    ctaLabel: "Update search preferences",
    ctaHref: "/profile",
  },
};

/**
 * The first blocking gate worth naming, or null when none is.
 *
 * READS THE SERVER'S VERDICT, NEVER RE-DERIVES IT. server/applications/bulkApply.ts
 * and lib/queueCapability.ts both refuse to re-run eligibility on the client, and
 * for the same reason: a second copy of a gate rule drifts from
 * evaluateEligibilityGates and can then disagree with it in either direction. This
 * takes the gate outcomes the server already returned and only decides how to
 * present one of them.
 *
 * Keyed on the gate name, not the reason code: plan_entitlement's code could gain
 * a second value (a per-destination quota, say) without changing what the
 * candidate has to do about it.
 */
export function findActionableBlocker(result: BulkApplyResult): ActionableBlocker | null {
  for (const outcome of result.outcomes) {
    if (outcome.status !== "blocked") {
      continue;
    }

    for (const entry of outcome.blockingGates) {
      const spec = ACTIONABLE_BLOCKERS[entry.gate];

      if (spec) {
        return { gate: entry.gate, reasonCode: entry.reasonCode, ...spec };
      }
    }
  }

  return null;
}
