/**
 * Client for the follow-up review endpoints:
 *   GET  /api/candidate/follow-ups/pending
 *   POST /api/candidate/follow-ups/:id/send
 *   POST /api/candidate/follow-ups/:id/dismiss
 *
 * Express calls rather than direct Supabase reads, even though
 * follow_up_drafts_select_own would allow the list to be read in the browser.
 * The two ACTIONS cannot be: a candidate's own role has no UPDATE grant on
 * follow_up_drafts, deliberately, because a status this product treats as
 * "approved for sending" must not be writable by the page that displays it.
 * Keeping all three on the server means the read and the writes cannot disagree
 * about what a draft is.
 *
 * Same injectable-deps shape as lib/bulkApply.ts and lib/attemptReview.ts.
 */

export interface PendingFollowUp {
  draftId: string;
  applicationAttemptId: string;
  /** Null for postings with no company row — aggregator and fixture vacancies often have none. */
  companyName: string | null;
  vacancyTitle: string;
  vacancyUrl: string;
  daysSinceSubmission: number;
  submittedAt: string;
  draftText: string;
  generatedAt: string;
  modelVersion: string;
  promptVersion: string;
}

export type ListPendingFollowUpsResult =
  | { kind: "success"; followUps: PendingFollowUp[] }
  | { kind: "error"; message: string };

/**
 * What the server actually did when a draft was approved.
 *
 * transmitted is typed as false rather than boolean, because in this phase it
 * cannot be anything else: there is no SMTP client, no mailbox for outbound
 * mail, and no recipient address anywhere in the schema. Typing it boolean
 * would invite a caller to write a branch that can never be taken, and typing
 * it false makes the omission visible at every call site that renders it.
 */
export interface SendFollowUpResult {
  kind: "success";
  draftId: string;
  transmitted: false;
  note: string;
}

export type FollowUpActionResult =
  | SendFollowUpResult
  | { kind: "success"; draftId: string; dismissed: true }
  | { kind: "error"; message: string };

export interface FollowUpDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string | null>;
}

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";
const NOT_FOUND = "This follow-up could not be found.";
const NO_LONGER_PENDING = "This follow-up is no longer awaiting your review.";
const NETWORK_ERROR = "Network error contacting the server.";
const LOAD_FAILED = "Could not load your follow-ups. Please try again.";
const SEND_FAILED = "Could not send this follow-up. Please try again.";
const DISMISS_FAILED = "Could not dismiss this follow-up. Please try again.";

async function defaultGetAccessToken(): Promise<string | null> {
  const { getSupabaseBrowserClient } = await import("./supabaseClient");
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

interface RequestOutcome {
  response: Response;
}

async function request(
  path: string,
  deps: FollowUpDeps,
  method: "GET" | "POST",
): Promise<RequestOutcome | { message: string }> {
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
      response: await fetchImpl(path, { method, headers: { Authorization: `Bearer ${accessToken}` } }),
    };
  } catch {
    return { message: NETWORK_ERROR };
  }
}

export async function listPendingFollowUps(deps: FollowUpDeps = {}): Promise<ListPendingFollowUpsResult> {
  const outcome = await request("/api/candidate/follow-ups/pending", deps, "GET");

  if ("message" in outcome) {
    return { kind: "error", message: outcome.message };
  }

  const { response } = outcome;

  if (response.status === 401) {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  if (!response.ok) {
    return { kind: "error", message: LOAD_FAILED };
  }

  try {
    const body = (await response.json()) as { followUps?: unknown };

    if (!Array.isArray(body.followUps)) {
      return { kind: "error", message: LOAD_FAILED };
    }

    return { kind: "success", followUps: body.followUps as PendingFollowUp[] };
  } catch {
    return { kind: "error", message: LOAD_FAILED };
  }
}

export async function sendFollowUp(
  draftId: string,
  deps: FollowUpDeps = {},
): Promise<FollowUpActionResult> {
  const outcome = await request(
    `/api/candidate/follow-ups/${encodeURIComponent(draftId)}/send`,
    deps,
    "POST",
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
  if (response.status === 409) {
    return { kind: "error", message: NO_LONGER_PENDING };
  }
  if (!response.ok) {
    return { kind: "error", message: SEND_FAILED };
  }

  try {
    const body = (await response.json()) as { draftId?: unknown; note?: unknown; transmitted?: unknown };

    if (typeof body.draftId !== "string") {
      return { kind: "error", message: SEND_FAILED };
    }

    return {
      kind: "success",
      draftId: body.draftId,
      transmitted: false,
      note: typeof body.note === "string" ? body.note : "Marked as sent.",
    };
  } catch {
    return { kind: "error", message: SEND_FAILED };
  }
}

export async function dismissFollowUp(
  draftId: string,
  deps: FollowUpDeps = {},
): Promise<FollowUpActionResult> {
  const outcome = await request(
    `/api/candidate/follow-ups/${encodeURIComponent(draftId)}/dismiss`,
    deps,
    "POST",
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
  if (response.status === 409) {
    return { kind: "error", message: NO_LONGER_PENDING };
  }
  if (!response.ok) {
    return { kind: "error", message: DISMISS_FAILED };
  }

  return { kind: "success", draftId, dismissed: true };
}

/**
 * How long the application has been waiting, in the words a person uses.
 *
 * The raw day count is kept alongside it, because "20 days" is the fact and
 * "3 weeks" is the reading of it; the UI shows the fact and may use this for
 * anything a sentence needs.
 */
export function describeWait(days: number): string {
  if (days <= 0) {
    return "applied today";
  }
  if (days === 1) {
    return "waiting 1 day";
  }

  // Days below a week, weeks from a week on. An earlier version switched at
  // fourteen days, which made its own "1 week" branch unreachable: the smallest
  // value that reached the weeks branch was 14, and floor(14/7) is 2. A test
  // asserting the seven-day case is what surfaced it.
  if (days < 7) {
    return `waiting ${days} days`;
  }

  const weeks = Math.floor(days / 7);
  return weeks === 1 ? "waiting 1 week" : `waiting ${weeks} weeks`;
}
