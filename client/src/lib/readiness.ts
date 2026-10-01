import type { Readiness, SetupStep } from "../../../shared/readiness";

/**
 * Client for GET /api/readiness — the Home setup checklist's data source.
 *
 * THE SERVER OWNS THE RULE. This only transports the Readiness object that
 * server/applications/readinessGate.ts derived from authoritative rows; it never
 * re-derives readiness from browser reads. A malformed or unexpected payload is
 * an ERROR, not a default, because the one thing the checklist must never do is
 * claim a candidate is set up when the server did not say so.
 */

/** The Automation card's anchor, so the consent step can scroll to its controls. */
export const AUTOMATION_CONSENT_ANCHOR_ID = "automation-consent";

export const READINESS_CHECK_FAILED = "Your setup progress couldn't be checked. Retry";

export type ReadinessState =
  | { kind: "loading" }
  | { kind: "ready"; readiness: Readiness }
  | { kind: "error"; message: string };

async function defaultGetAccessToken(): Promise<string | null> {
  const { getSupabaseBrowserClient } = await import("./supabaseClient");
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

export interface FetchReadinessDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string | null>;
}

const SETUP_STEP_IDS = ["resume", "target_roles", "search_preferences", "submission_consent"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAction(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.label === "string" &&
      (value.route === null || typeof value.route === "string"))
  );
}

function isStep(value: unknown): value is SetupStep {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (SETUP_STEP_IDS as readonly string[]).includes(value.id) &&
    typeof value.label === "string" &&
    typeof value.complete === "boolean" &&
    typeof value.detail === "string" &&
    isAction(value.action) &&
    (value.timestamp === null || typeof value.timestamp === "string")
  );
}

function isReadiness(value: unknown): value is Readiness {
  if (!isRecord(value)) {
    return false;
  }
  if (!Array.isArray(value.steps) || value.steps.length !== SETUP_STEP_IDS.length) {
    return false;
  }
  if (!value.steps.every(isStep) || !Array.isArray(value.blockers)) {
    return false;
  }

  return (
    typeof value.completedSteps === "number" &&
    typeof value.totalSteps === "number" &&
    typeof value.setupComplete === "boolean" &&
    typeof value.primaryState === "string" &&
    typeof value.resumeReady === "boolean" &&
    typeof value.rolesReady === "boolean" &&
    typeof value.preferencesReady === "boolean" &&
    typeof value.consentReady === "boolean"
  );
}

export async function fetchReadiness(deps: FetchReadinessDeps = {}): Promise<ReadinessState> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;

  let accessToken: string | null;

  try {
    accessToken = await getAccessToken();
  } catch {
    return { kind: "error", message: READINESS_CHECK_FAILED };
  }

  if (!accessToken) {
    return { kind: "error", message: READINESS_CHECK_FAILED };
  }

  let response: Response;

  try {
    response = await fetchImpl("/api/readiness", {
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken },
    });
  } catch {
    return { kind: "error", message: READINESS_CHECK_FAILED };
  }

  if (!response.ok) {
    return { kind: "error", message: READINESS_CHECK_FAILED };
  }

  try {
    const body: unknown = await response.json();

    if (!isReadiness(body)) {
      return { kind: "error", message: READINESS_CHECK_FAILED };
    }

    return { kind: "ready", readiness: body };
  } catch {
    return { kind: "error", message: READINESS_CHECK_FAILED };
  }
}
