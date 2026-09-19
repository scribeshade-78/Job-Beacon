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
