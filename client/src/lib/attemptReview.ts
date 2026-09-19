import type { ResumeOptimizationLevel } from "./applicationPreferences";

/**
 * Client for the two candidate-facing review endpoints:
 *   POST /api/candidate/attempts/:id/generate-preview
 *   POST /api/candidate/attempts/:id/approve
 *
 * Express calls rather than direct Supabase writes, and they have to be:
 * generating a tailored resume runs the model and writes to private Storage,
 * and approving flips application_attempts.status — on which the candidate's
 * own role has SELECT only. There is deliberately no way for the browser to
 * make either change itself.
 *
 * Same injectable-deps shape as lib/bulkApply.ts so the request handling is
 * testable without a server or a session.
 */

/**
 * The letter this attempt will send, or why there isn't one.
 *
 * Modelled as an outcome rather than an optional string for the same reason the
 * server does: "no letter" and "the letter failed its honesty gate" look
 * identical to a nullable field, and only one of them is something the
 * candidate might want to act on.
 */
export type CoverLetterPreview =
  | {
      status: "generated";
      text: string;
      promptVersion: string;
      modelVersion: string;
      citedFactCount: number;
      generatedAt: string;
    }
  | { status: "failed"; reason: string };

export interface AttemptPreview {
  applicationAttemptId: string;
  previewUrl: string;
  previewUrlExpiresInSeconds: number;
  /** False when the resume was already prepared and this call reused it. */
  resumePrepared: boolean;
  resume: {
    documentId: string;
    originalFilename: string;
    tailored: boolean;
    optimizationLevel: ResumeOptimizationLevel;
  };
  coverLetter: CoverLetterPreview;
}

export type RequestAttemptPreviewResult =
  | { kind: "success"; preview: AttemptPreview }
  | { kind: "error"; message: string };

export type ApproveAttemptResult =
  | { kind: "success"; reviewApprovedAt: string }
  | { kind: "error"; message: string };

export interface AttemptReviewDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string | null>;
}

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";
const NOT_FOUND = "This application could not be found.";
const NOT_AWAITING_REVIEW = "This application is no longer waiting for your review.";
const PREVIEW_REQUIRED = "Create the resume preview before approving this application.";
const NETWORK_ERROR = "Network error contacting the server.";
const PREVIEW_FAILED = "Could not prepare your resume preview. Please try again.";
const APPROVE_FAILED = "Could not approve this application. Please try again.";

async function defaultGetAccessToken(): Promise<string | null> {
  const { getSupabaseBrowserClient } = await import("./supabaseClient");
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Issues one authenticated POST and returns the response, or null with a
 * message when the request never reached the server. Shared so both endpoints
 * cannot drift on the session/network handling.
 */
async function postAuthenticated(
  path: string,
  deps: AttemptReviewDeps,
): Promise<{ response: Response } | { message: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;

  let accessToken: string | null;
  try {
    accessToken = await getAccessToken();
  } catch {
    return { message: SESSION_EXPIRED };
  }

  if (!accessToken) {
    return { message: SESSION_EXPIRED };
  }

  try {
    return {
      response: await fetchImpl(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      }),
    };
  } catch {
    return { message: NETWORK_ERROR };
  }
}

export async function requestAttemptPreview(
  applicationAttemptId: string,
  deps: AttemptReviewDeps = {},
): Promise<RequestAttemptPreviewResult> {
  const outcome = await postAuthenticated(
    `/api/candidate/attempts/${encodeURIComponent(applicationAttemptId)}/generate-preview`,
    deps,
  );

  if ("message" in outcome) {
    return { kind: "error", message: outcome.message };
  }

  const { response } = outcome;

  if (response.status === 401) {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  // 404 covers both "no such attempt" and "not yours" — the server answers
  // identically on purpose, so the browser cannot tell them apart either, and
  // neither should the copy.
  if (response.status === 404) {
    return { kind: "error", message: NOT_FOUND };
  }

  if (response.status === 409) {
    return { kind: "error", message: NOT_AWAITING_REVIEW };
  }

  if (!response.ok) {
    return { kind: "error", message: PREVIEW_FAILED };
  }

  try {
    return { kind: "success", preview: (await response.json()) as AttemptPreview };
  } catch {
    return { kind: "error", message: PREVIEW_FAILED };
  }
}

export async function approveReviewedAttempt(
  applicationAttemptId: string,
  deps: AttemptReviewDeps = {},
): Promise<ApproveAttemptResult> {
  const outcome = await postAuthenticated(
    `/api/candidate/attempts/${encodeURIComponent(applicationAttemptId)}/approve`,
    deps,
  );

  if ("message" in outcome) {
    return { kind: "error", message: outcome.message };
  }

  const { response } = outcome;

  if (response.status === 401) {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  if (response.status === 404) {
    return { kind: "error", message: NOT_FOUND };
  }

  // Both 409s arrive with distinct server copy, but the browser shows its own
  // so the "you must preview first" case reads as guidance rather than as an
  // error code. The server's message is used only where it adds something.
  if (response.status === 409) {
    const message = await readServerError(response);
    return { kind: "error", message: message ?? NOT_AWAITING_REVIEW };
  }

  if (!response.ok) {
    return { kind: "error", message: APPROVE_FAILED };
  }

  try {
    const body = (await response.json()) as { reviewApprovedAt?: unknown };

    if (typeof body.reviewApprovedAt !== "string") {
      return { kind: "error", message: APPROVE_FAILED };
    }

    return { kind: "success", reviewApprovedAt: body.reviewApprovedAt };
  } catch {
    return { kind: "error", message: APPROVE_FAILED };
  }
}

/**
 * The server's own 409 copy, when it says something the browser does not.
 * Only the "preview first" case qualifies — that one is actionable and the
 * client cannot infer it from the status code alone.
 */
async function readServerError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };

    if (typeof body.error !== "string") {
      return null;
    }

    return body.error.includes("preview") ? PREVIEW_REQUIRED : null;
  } catch {
    return null;
  }
}
