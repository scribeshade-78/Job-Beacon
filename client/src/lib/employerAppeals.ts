/**
 * R5.4c client layer. Unlike employer.ts/companyFactCorrections.ts, this
 * one has no RLS-direct read at all — moderation_cases/moderation_decisions
 * are service_role-only (no authenticated grant), so even "list my own
 * blocked vacancies" has to be a server route.
 */
export interface BlockedVacancyEntry {
  vacancyId: string;
  title: string;
  url: string;
  decisionId: string;
  decisionRationale: string;
  decisionPolicyVersion: string;
  decisionCreatedAt: string;
  hasPendingAppeal: boolean;
}

const GENERIC_BLOCKED_FAILURE_MESSAGE = "Could not load your blocked vacancies. Please try again.";

export type ListBlockedVacanciesResult =
  | { kind: "success"; entries: BlockedVacancyEntry[] }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

export async function listBlockedVacancies(
  companyId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ListBlockedVacanciesResult> {
  let response: Response;

  try {
    response = await fetchImpl(`/api/employer/companies/${companyId}/blocked-vacancies`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "forbidden" };
  }

  if (!response.ok) {
    return { kind: "error", message: GENERIC_BLOCKED_FAILURE_MESSAGE };
  }

  const entries = (await response.json()) as BlockedVacancyEntry[];
  return { kind: "success", entries };
}

const GENERIC_APPEAL_FAILURE_MESSAGE = "Could not submit your appeal. Please try again.";

export type SubmitVacancyAppealResult = { kind: "success" } | { kind: "error"; message: string };

export async function submitVacancyAppeal(
  companyId: string,
  vacancyId: string,
  rationale: string,
  evidence: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitVacancyAppealResult> {
  let response: Response;

  try {
    response = await fetchImpl("/api/employer/appeals", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        companyId,
        vacancyId,
        rationale,
        evidence: evidence.trim() === "" ? undefined : evidence,
      }),
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (!response.ok) {
    let message = GENERIC_APPEAL_FAILURE_MESSAGE;

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

export interface AppealQueueEntry {
  caseId: string;
  appealId: string;
  vacancyId: string;
  vacancyTitle: string;
  vacancyUrl: string;
  appealRationale: string;
  appealEvidence: unknown;
  evidenceDeadline: string | null;
  originalDecisionId: string;
  originalDecisionRationale: string;
  originalDecisionPolicyVersion: string;
  createdAt: string;
}

const GENERIC_QUEUE_FAILURE_MESSAGE = "Could not load the appeals queue. Please try again.";

export type GetAppealsQueueResult =
  | { kind: "success"; entries: AppealQueueEntry[] }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

export async function getAppealsQueue(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GetAppealsQueueResult> {
  let response: Response;

  try {
    response = await fetchImpl("/api/moderation/appeals", {
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

  const entries = (await response.json()) as AppealQueueEntry[];
  return { kind: "success", entries };
}
