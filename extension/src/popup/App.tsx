import { useEffect, useState } from "react";

/**
 * The popup: connect once, then one button.
 *
 * NOTHING FILLS UNTIL THE BUTTON IS PRESSED, and nothing is ever submitted. The
 * extension's whole value is that it saves typing into a form the candidate is already
 * looking at; it does not decide to apply anywhere, and it cannot - there is no submit
 * path in this codebase.
 */
export function App() {
  const [token, setToken] = useState("");
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "idle" | "ok" | "error"; text: string }>({
    tone: "idle",
    text: "Open a job application form, then press Auto-Fill.",
  });

  useEffect(() => {
    void chrome.storage.local.get("apiToken").then((result) => {
      const existing = typeof result.apiToken === "string" ? result.apiToken : "";
      setToken(existing);
      setStored(existing.length > 0);
    });
  }, []);

  async function saveToken() {
    await chrome.storage.local.set({ apiToken: token.trim() });
    setStored(token.trim().length > 0);
    setStatus({ tone: "ok", text: token.trim() ? "Token saved." : "Token cleared." });
  }

  async function autoFill() {
    setBusy(true);
    setStatus({ tone: "idle", text: "Reading your profile..." });

    try {
      const profileReply = await chrome.runtime.sendMessage({ type: "FETCH_PROFILE" });
      if (!profileReply?.ok) {
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

      // REPORT WHAT ACTUALLY HAPPENED, including what was left alone. A popup that
      // said "Done!" without this would hide the case that matters most: a field it
      // chose not to touch because the candidate had already answered it.
      const report = fillReply.report as {
        filled: string[];
        skipped: { field: string; reason: string }[];
      };
      const summary =
        report.filled.length > 0
          ? "Filled " + report.filled.join(", ") + "."
          : "Nothing filled - see below.";
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

  return (
    <div className="flex flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-control bg-ios-blue text-sm font-bold text-white">
          JB
        </span>
        <div>
          <h1 className="text-sm font-semibold">Auto-Apply</h1>
          <p className="text-xs text-ios-text-secondary">
            {stored ? "Connected to JobBeacon" : "Not connected"}
          </p>
        </div>
      </header>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ios-text-secondary">API token</span>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Paste the token from JobBeacon"
          className="rounded-control border border-ios-separator bg-ios-card px-2.5 py-1.5 text-sm"
        />
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void saveToken()}
          className="rounded-control border border-ios-separator bg-ios-card px-3 py-1.5 text-sm font-medium"
        >
          Save token
        </button>
        <button
          type="button"
          onClick={() => void autoFill()}
          disabled={busy || !stored}
          className="flex-1 rounded-control bg-ios-blue-button px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Filling..." : "Auto-Fill Page"}
        </button>
      </div>

      <p
        className={
          "rounded-control border p-2.5 text-xs " +
          (status.tone === "error"
            ? "border-ios-separator bg-ios-card text-ios-text"
            : "border-ios-separator bg-ios-card text-ios-text-secondary")
        }
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
