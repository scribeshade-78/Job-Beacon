/**
 * R3.1 moderator console client — same "server-side Express route, not a
 * direct Supabase call" shape as extractResumeFacts in resumeExtraction.ts:
 * moderation_cases/moderation_decisions grant service_role only (no
 * request-scoped RLS client exists in this project), so both operations go
 * through requireAuth + requireModerator-protected routes.
 */
export const MODERATION_DECISIONS = ["cleared", "flagged", "blocked", "request_info", "escalated"] as const;

export type ModerationDecisionValue = (typeof MODERATION_DECISIONS)[number];

/** Bumped whenever the decision rationale/criteria change materially, so past decisions stay tied to the policy in force when they were made — same pattern as automationAuthorization.ts's CONSENT_VERSION. */
export const MODERATION_POLICY_VERSION = "r3-moderation-v1";

export interface ModerationQueueEntry {
  caseId: string;
  vacancyId: string;
  vacancyTitle: string;
  vacancyUrl: string;
  sourceType: string;
  severity: string;
  evidenceSnapshot: unknown;
  createdAt: string;
}

const GENERIC_QUEUE_FAILURE_MESSAGE = "Could not load the moderation queue. Please try again.";

export type GetModerationQueueResult =
  | { kind: "success"; entries: ModerationQueueEntry[] }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

export async function getModerationQueue(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GetModerationQueueResult> {
  let response: Response;

  try {
    response = await fetchImpl("/api/moderation/queue", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "forbidden" };
  }

  if (!response.ok) {
    return { kind: "error", message: GENERIC_QUEUE_FAILURE_MESSAGE };
  }

  const entries = (await response.json()) as ModerationQueueEntry[];
  return { kind: "success", entries };
}

const GENERIC_DECISION_FAILURE_MESSAGE = "Could not record this decision. Please try again.";

export type SubmitModerationDecisionResult = { kind: "success" } | { kind: "error"; message: string };

export async function submitModerationDecision(
  caseId: string,
  decision: ModerationDecisionValue,
  rationale: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitModerationDecisionResult> {
  let response: Response;

  try {
    response = await fetchImpl(`/api/moderation/cases/${caseId}/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ decision, rationale, policyVersion: MODERATION_POLICY_VERSION }),
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (!response.ok) {
    let message = GENERIC_DECISION_FAILURE_MESSAGE;

    try {
      const body = await response.json();
      if (typeof body?.error === "string" && body.error.trim() !== "") {
        message = body.error;
      }
    } catch {
      // Fall back to the generic message.
    }

    return { kind: "error", message };
  }

  return { kind: "success" };
}
