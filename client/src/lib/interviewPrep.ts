/**
 * Interview Preparation Phase 2 — the client's call to the prep endpoint.
 *
 * Calls the server rather than Supabase directly: generation needs the
 * server-held OPENROUTER_API_KEY, and the endpoint is the only thing that
 * resolves the candidate's confirmed facts. Same injectable-fetchImpl shape as
 * extractResumeFacts and fetchVerifiedIdentity.
 *
 * The request takes only a vacancy id — the job description and the candidate
 * context are both resolved server-side, so nothing here can influence what
 * experience the model is told the candidate has.
 */

export interface InterviewTechnicalQuestion {
  question: string;
  topic: string;
  why: string;
}

export interface InterviewBehavioralQuestion {
  question: string;
  competency: string;
  why: string;
}

/**
 * A STAR component may be an EMPTY STRING, and that is meaningful: it is how the
 * server reports "the confirmed facts did not support this", because the model
 * is explicitly forbidden from inventing detail to fill the gap. Renderers must
 * present that as an honest gap, never as a blank line a candidate could read as
 * a loading artefact or missing data.
 */
export interface InterviewStarPoint {
  question: string;
  situation: string;
  task: string;
  action: string;
  result: string;
}

export interface InterviewPrep {
  technical_questions: InterviewTechnicalQuestion[];
  behavioral_questions: InterviewBehavioralQuestion[];
  star_talking_points: InterviewStarPoint[];
  /** JD requirements with no supporting confirmed fact. */
  gaps: string[];
}

export type InterviewPrepRequestResult =
  | { kind: "success"; prep: InterviewPrep }
  /**
   * A 4xx: the server refused and explained why (the vacancy is not verified, or
   * it has no JD text). Retrying the same request cannot help, so the UI must
   * not offer a retry for this case.
   */
  | { kind: "unavailable"; message: string }
  /** Network failure or 5xx — transient, so a retry is worth offering. */
  | { kind: "error"; message: string };

const GENERIC_FAILURE_MESSAGE = "Interview preparation could not be generated. Please try again.";

export async function requestInterviewPrep(
  vacancyId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InterviewPrepRequestResult> {
  let response: Response;

  try {
    response = await fetchImpl(`/api/vacancies/${vacancyId}/interview-prep`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (!response.ok) {
    let message = GENERIC_FAILURE_MESSAGE;

    try {
      const body = await response.json();
      if (typeof body?.error === "string" && body.error.trim() !== "") {
        message = body.error;
      }
    } catch {
      // Fall back to the generic message.
    }

    // 4xx is the server declining on the merits; 5xx is infrastructure. The two
    // deserve different affordances, so they are not collapsed here the way
    // extractResumeFacts collapses them.
    return response.status >= 400 && response.status < 500
      ? { kind: "unavailable", message }
      : { kind: "error", message };
  }

  try {
    return { kind: "success", prep: (await response.json()) as InterviewPrep };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

/**
 * Session-scoped cache, keyed by vacancy id.
 *
 * Generation costs a paid OpenRouter call and nothing is persisted server-side,
 * so without this every reopen of the dialog silently re-bills for the same
 * vacancy. Deliberately module-level rather than component state: the dialog
 * unmounts when it closes, and a cache that dies with it would not survive the
 * exact case it exists for. Same module-level-singleton precedent as auth.ts's
 * store.
 *
 * In memory only — a page reload starts clean, and nothing is written to
 * storage.
 */
const prepCache = new Map<string, InterviewPrep>();

export function getCachedInterviewPrep(vacancyId: string): InterviewPrep | undefined {
  return prepCache.get(vacancyId);
}

export function setCachedInterviewPrep(vacancyId: string, prep: InterviewPrep): void {
  prepCache.set(vacancyId, prep);
}

/** Test-only: stops one case's cached prep leaking into the next. */
export function clearInterviewPrepCache(): void {
  prepCache.clear();
}
