import { useEffect, useState } from "react";
import type { SessionInfo } from "../lib/types.js";
import { readAttemptId } from "../lib/loop.js";

/**
 * The popup has two faces: sign in, or auto-fill.
 *
 * IT NEVER TOUCHES A CREDENTIAL BEYOND THE MOMENT OF SIGN-IN. The password goes straight
 * to the service worker, which hands it to Supabase, and nothing is kept here. The popup
 * cannot read the session token either - it asks the worker what the session IS
 * (signedIn, email) and asks the worker to do the fetching.
 *
 * NOTHING FILLS UNTIL THE BUTTON IS PRESSED, and nothing is ever submitted.
 */
export function App() {
  // 'checking' first, so the popup never flashes a login form at someone who is already
  // signed in - reading the session is async and the first render happens before it.
  const [checking, setChecking] = useState(true);
  const [session, setSession] = useState<SessionInfo>({ signedIn: false, email: "" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // The attempt this tab was opened for, or null. Read from the tab's URL, which the Tracker
  // tagged; a page opened normally has none and the approval block simply does not render.
  const [armed, setArmed] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [status, setStatus] = useState<{ tone: "idle" | "ok" | "error"; text: string }>({
    tone: "idle",
    text: "Open a job application form, then press Auto-Fill.",
  });

  useEffect(() => {
    void chrome.runtime
      .sendMessage({ type: "GET_SESSION" })
      .then((reply) => {
        if (reply?.ok && reply.session) {
          setSession(reply.session as SessionInfo);
        }
      })
      .finally(() => setChecking(false));

    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) {
        setArmed(readAttemptId(tab.url) ?? null);
      }
    })();
  }, []);

  /**
   * The candidate's explicit approval, and only then a submission token.
   *
   * THE ORDER IS THE DESIGN AND IT IS ENFORCED SERVER-SIDE. This records the approval on the
   * attempt, then authorizes - two calls, in that order. authorizeSubmission refuses with
   * NOT_APPROVED when application_attempts.review_approved_at is null, so a client that
   * skipped the first call would be refused rather than trusted.
   *
   * IT DOES NOT SUBMIT. The candidate presses submit on the page themselves; the content
   * script only watches for the click and reports what the portal said afterwards.
   */
  async function approveAndAuthorize() {
    setBusy(true);
    setStatus({ tone: "idle", text: "Recording your approval..." });

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        throw new Error("No active tab.");
      }

      const reply = await chrome.tabs.sendMessage(tab.id, { type: "JB_APPROVE" });

      if (!reply?.ok) {
        throw new Error(reply?.error ?? "The page could not complete the approval.");
      }

      if (!reply.allowed) {
        // A refusal carries a reason code from the server, which is more useful than a
        // generic failure: the attempt may already be sent, or the allowance may be spent.
        setStatus({ tone: "error", text: "Not ready to submit: " + String(reply.refusal ?? "refused") + "." });
        return;
      }

      setApproved(true);
      setStatus({ tone: "ok", text: "Approved. Review the form, then press the site's submit button." });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function signIn() {
    setBusy(true);
    setStatus({ tone: "idle", text: "Signing in..." });

    try {
      const reply = await chrome.runtime.sendMessage({ type: "SIGN_IN", email, password });
      if (!reply?.ok) {
        throw new Error(reply?.error ?? "Could not sign in.");
      }
      setSession(reply.session as SessionInfo);
      // Cleared immediately: a password left in component state is a password left in a
      // DOM node, and this popup can stay open on screen.
      setPassword("");
      setStatus({ tone: "idle", text: "Open a job application form, then press Auto-Fill." });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const reply = await chrome.runtime.sendMessage({ type: "SIGN_OUT" });
      if (reply?.ok && reply.session) {
        setSession(reply.session as SessionInfo);
      }
      setPassword("");
      setStatus({ tone: "idle", text: "Signed out." });
    } finally {
      setBusy(false);
    }
  }

  async function autoFill() {
    setBusy(true);
    setStatus({ tone: "idle", text: "Reading your profile..." });

    try {
      const profileReply = await chrome.runtime.sendMessage({ type: "FETCH_PROFILE" });

      if (!profileReply?.ok) {
        // An expired session is a STATE, not a failure: show the login screen again
        // rather than an error the candidate cannot act on.
        if (/expired|refused/i.test(profileReply?.error ?? "")) {
          setSession({ signedIn: false, email: "" });
        }
        throw new Error(profileReply?.error ?? "Could not read your profile.");
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        throw new Error("No active tab.");
      }

      const fillReply = await chrome.tabs.sendMessage(tab.id, {
        type: "FILL_FORM",
        profile: profileReply.profile,
      });

      if (!fillReply?.ok) {
        throw new Error(fillReply?.error ?? "The page refused the fill.");
      }

      const report = fillReply.report as {
        filled: string[];
        skipped: { field: string; reason: string }[];
      };
      const summary =
        report.filled.length > 0 ? "Filled " + report.filled.join(", ") + "." : "Nothing filled - see below.";
      const skipped = report.skipped.map((s) => s.field + ": " + s.reason).join(" ");
      setStatus({
        tone: report.filled.length > 0 ? "ok" : "error",
        text: summary + (skipped ? " " + skipped : ""),
      });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const fieldClass = "rounded-control border border-ios-separator bg-ios-card px-2.5 py-1.5 text-sm";

  return (
    <div className="flex flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-control bg-ios-blue text-sm font-bold text-white">
          JB
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Auto-Apply</h1>
          <p className="truncate text-xs text-ios-text-secondary">
            {checking ? "Checking your session..." : session.signedIn ? session.email : "Signed out"}
          </p>
        </div>
        {session.signedIn ? (
          <button
            type="button"
            onClick={() => void signOut()}
            disabled={busy}
            className="rounded-control border border-ios-separator bg-ios-card px-2 py-1 text-xs font-medium"
          >
            Sign out
          </button>
        ) : null}
      </header>

      {checking ? null : !session.signedIn ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ios-text-secondary">Email</span>
            <input
              type="email"
              value={email}
              autoComplete="username"
              onChange={(event) => setEmail(event.target.value)}
              className={fieldClass}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ios-text-secondary">Password</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && email && password && !busy) {
                  void signIn();
                }
              }}
              className={fieldClass}
            />
          </label>

          <button
            type="button"
            onClick={() => void signIn()}
            disabled={busy || !email || !password}
            className="rounded-control bg-ios-blue-button px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Signing in..." : "Sign in to JobBeacon"}
          </button>
        </>
      ) : (
        <>
          {armed !== null ? (
            <div className="rounded-control border border-ios-separator bg-ios-bg p-2.5">
              <p className="text-xs font-medium">Application ready to review</p>
              <p className="mt-1 text-[11px] text-ios-text-secondary">
                Check every answer below, then approve. We never press submit for you.
              </p>
              <button
                type="button"
                onClick={() => void approveAndAuthorize()}
                disabled={busy || approved}
                className="mt-2 w-full rounded-control bg-ios-blue-button px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {approved ? "Approved" : busy ? "Approving..." : "Approve this application"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void autoFill()}
              disabled={busy}
              className="rounded-control bg-ios-blue-button px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Filling..." : "Auto-Fill Page"}
            </button>
          )}
        </>
      )}

      <p
        className="rounded-control border border-ios-separator bg-ios-card p-2.5 text-xs text-ios-text-secondary"
        role="status"
        aria-live="polite"
      >
        {status.text}
      </p>

      <p className="text-[11px] text-ios-text-secondary">
        Nothing is submitted for you. Review every answer before you apply.
      </p>
    </div>
  );
}
