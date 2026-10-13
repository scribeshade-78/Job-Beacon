/**
 * The service worker. It owns the session and the network, and the popup owns the UI.
 *
 * WHY THE WORKER AND NOT THE POPUP:
 *
 *  1. A CONTENT SCRIPT'S FETCH CARRIES THE PAGE'S ORIGIN. Calling jobbeacon.in from a
 *     content script on greenhouse.io is judged against greenhouse's CORS policy, so it
 *     fails unless JobBeacon sends permissive headers to every ATS on the internet. The
 *     worker fetches as the extension, against host_permissions naming one origin.
 *
 *  2. THE POPUP IS DESTROYED WHEN IT CLOSES. A session that lived only there would be
 *     gone the moment the candidate clicked away, and the refresh timer with it.
 *
 *  3. ONE COPY OF THE TOKEN. The popup asks for work to be done and receives results; it
 *     never holds the credential, so there is a single context that could leak it.
 *
 * THE SESSION IS THE CANDIDATE'S OWN SUPABASE SESSION, obtained by signing in with their
 * email and password exactly as the web app does. No long-lived API token is issued,
 * stored, or rotated, and signing out in either place ends it.
 */
import { freshAccessToken, supabase } from "./lib/supabase.js";
import type { CandidateProfile, SessionInfo } from "./lib/types.js";

const API_BASE = "https://jobbeacon.in";

/**
 * An authenticated call to a JobBeacon extension endpoint.
 *
 * THE PATH IS ALWAYS A LITERAL. No caller supplies one, so the extension can never be talked
 * into fetching an arbitrary URL with the candidate's bearer token attached - the failure
 * mode a message-passing API invites when the path is a parameter.
 */
async function authedFetch(path: string, init?: RequestInit): Promise<unknown> {
  const token = await freshAccessToken();

  if (!token) {
    throw new Error("Your session has expired. Sign in again.");
  }

  const response = await fetch(API_BASE + path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: "Bearer " + token,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (response.status === 401) {
    throw new Error("The server refused this session. Sign in again.");
  }

  // A REFUSAL IS NOT A TRANSPORT ERROR, and the caller needs the reason. The routes answer
  // 404 and 409 with a refusal payload, so the body is returned rather than thrown: the
  // extension's job is to show the candidate why, not to flatten every no into "failed".
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    throw new Error("JobBeacon answered HTTP " + response.status + ".");
  }

  return body;
}

/**
 * TRIP 1. Claims the attempt and returns what to type into the form.
 *
 * This is the call that MINTS the lease. Nothing is submitted here, and nothing can be: the
 * response carries no submission permission, only the data and the credentials Trip 2 will
 * present.
 */
async function prepareFill(attemptId: string): Promise<unknown> {
  return authedFetch("/api/extension/auto-apply/fill-payload?attemptId=" + encodeURIComponent(attemptId));
}

/**
 * TRIP 2. Called ONLY after the candidate has approved the filled form.
 *
 * The lease token travels here and nowhere else. There is no timer, no retry and no
 * automatic path into this function: if the candidate never presses Approve, it is never
 * called, and no submission token is ever minted.
 */
async function authorizeSubmit(attemptId: string, leaseToken: string): Promise<unknown> {
  return authedFetch("/api/extension/auto-apply/authorize", {
    method: "POST",
    body: JSON.stringify({ attemptId, leaseToken }),
  });
}

/**
 * TRIP 3. What actually happened.
 *
 * The outcome and its evidence are decided by the CONTENT SCRIPT, which is the only context
 * that can see the page. This forwards what it saw without embellishment - the server
 * decides whether it counts, and it refuses a success claim that carries no proof.
 */
async function reportOutcome(payload: Record<string, unknown>): Promise<unknown> {
  return authedFetch("/api/extension/auto-apply/outcome", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}


/** The popup's view of the session - never the token. */
async function sessionInfo(): Promise<SessionInfo> {
  const { data } = await supabase().auth.getSession();
  const session = data.session;

  return {
    signedIn: Boolean(session),
    email: session?.user?.email ?? "",
  };
}

async function signIn(email: string, password: string): Promise<SessionInfo> {
  const { data, error } = await supabase().auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    // Re-thrown rather than returned so the popup has one error path. Supabase's own
    // wording is kept: "Invalid login credentials" is more useful than a rewrite.
    throw new Error(error?.message ?? "Could not sign in.");
  }

  return { signedIn: true, email: data.session.user.email ?? email };
}

async function signOut(): Promise<SessionInfo> {
  await supabase().auth.signOut();
  // Belt and braces: a signOut that failed to clear the store would leave a session the
  // user believes they ended. The storage key is the client's own, set in supabase.ts.
  await chrome.storage.local.remove("jobbeacon-extension-auth");
  return { signedIn: false, email: "" };
}

/**
 * The candidate's profile, from the endpoint the web app's own session already trusts.
 *
 * THE TOKEN IS OBTAINED HERE AND USED IMMEDIATELY, never stored separately and never
 * returned to the popup. An expired session returns null rather than an error, so the
 * popup can show the login screen again instead of a failure message.
 */
async function fetchProfile(): Promise<CandidateProfile> {
  const token = await freshAccessToken();

  if (!token) {
    throw new Error("Your session has expired. Sign in again.");
  }

  const response = await fetch(API_BASE + "/api/extension/profile", {
    headers: { Authorization: "Bearer " + token },
  });

  if (response.status === 401) {
    throw new Error("The server refused this session. Sign in again.");
  }
  if (!response.ok) {
    throw new Error("JobBeacon answered HTTP " + response.status + ".");
  }

  return (await response.json()) as CandidateProfile;
}

/**
 * One listener, one async dispatcher.
 *
 * EVERY BRANCH MUST ANSWER. A message that returns undefined leaves the popup's promise
 * pending forever, so the dispatcher is written to always send something - including on a
 * thrown error - and returns true to keep the channel open for the async reply.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;

  if (
    type !== "GET_SESSION" &&
    type !== "SIGN_IN" &&
    type !== "SIGN_OUT" &&
    type !== "FETCH_PROFILE" &&
    type !== "PREPARE_FILL" &&
    type !== "AUTHORIZE_SUBMIT" &&
    type !== "REPORT_OUTCOME"
  ) {
    return false;
  }

  void (async () => {
    try {
      switch (type) {
        case "GET_SESSION":
          sendResponse({ ok: true, session: await sessionInfo() });
          return;
        case "SIGN_IN":
          sendResponse({ ok: true, session: await signIn(String(message.email ?? ""), String(message.password ?? "")) });
          return;
        case "SIGN_OUT":
          sendResponse({ ok: true, session: await signOut() });
          return;
        case "FETCH_PROFILE":
          sendResponse({ ok: true, profile: await fetchProfile() });
          return;
        case "PREPARE_FILL":
          sendResponse({ ok: true, payload: await prepareFill(String(message.attemptId ?? "")) });
          return;
        case "AUTHORIZE_SUBMIT":
          sendResponse({
            ok: true,
            result: await authorizeSubmit(String(message.attemptId ?? ""), String(message.leaseToken ?? "")),
          });
          return;
        case "REPORT_OUTCOME":
          sendResponse({ ok: true, result: await reportOutcome((message.payload ?? {}) as Record<string, unknown>) });
          return;
      }
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();

  return true;
});
