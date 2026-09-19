import { useEffect, useState } from "react";
import {
  getModerationQueue,
  submitModerationDecision,
  MODERATION_DECISIONS,
  type ModerationDecisionValue,
  type ModerationQueueEntry,
} from "../../lib/moderation";
import { safeVacancyHref } from "../../panels/shared";
import { AdminCard, SectionMessage, getAccessToken } from "./shared";

const DECISION_LABEL: Record<ModerationDecisionValue, string> = {
  cleared: "Clear",
  flagged: "Flag",
  blocked: "Block",
  request_info: "Request info",
  escalated: "Escalate",
};

/**
 * R8.1: the admin console reuses the existing moderation lib/routes
 * (regated to requireModeratorOrAdmin server-side) — a compact review list,
 * not a rebuild of the full ModeratorPage split-pane UI.
 */
export function ModerationSection() {
  const [queue, setQueue] = useState<ModerationQueueEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      return;
    }

    const result = await getModerationQueue(accessToken);
    if (result.kind === "success") {
      setQueue(result.entries);
      setError(null);
    } else if (result.kind === "forbidden") {
      setError("You don't have moderator or admin access.");
    } else {
      setError(result.message);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const selectedCase = queue?.find((entry) => entry.caseId === selectedCaseId) ?? null;

  async function decide(decision: ModerationDecisionValue) {
    if (!selectedCase || rationale.trim() === "") {
      setError("Select a case and enter a rationale first.");
      return;
    }

    setBusy(true);
    setError(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setBusy(false);
      return;
    }

    const result = await submitModerationDecision(selectedCase.caseId, decision, rationale.trim(), accessToken);
    if (result.kind === "error") {
      setError(result.message);
    } else {
      setRationale("");
      setSelectedCaseId(null);
      await refresh();
    }

    setBusy(false);
  }

  return (
    <AdminCard title="Moderation queue" description="Open cases from moderation_cases (no decision yet), newest severity first.">
      {error && <SectionMessage tone="error">{error}</SectionMessage>}

      {queue === null ? (
        <SectionMessage tone="muted">Loading…</SectionMessage>
      ) : queue.length === 0 ? (
        <SectionMessage tone="muted">No open cases.</SectionMessage>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <ul className="space-y-2">
            {queue.map((entry) => (
              <li key={entry.caseId}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCaseId(entry.caseId);
                    setRationale("");
                    setError(null);
                  }}
                  aria-current={entry.caseId === selectedCaseId ? "true" : undefined}
                  className={`w-full rounded-md border p-3 text-left transition-colors ${
                    entry.caseId === selectedCaseId
                      ? "border-sky-500 bg-sky-500/10"
                      : "border-slate-800 bg-slate-950/40 hover:bg-slate-800/40"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold uppercase tracking-wide text-slate-400">{entry.severity}</span>
                    <span className="text-slate-600">{entry.sourceType}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-200">{entry.vacancyTitle || "(untitled)"}</p>
                </button>
              </li>
            ))}
          </ul>

          <div className="rounded-md border border-slate-800 bg-slate-950/40 p-4">
            {!selectedCase ? (
              <SectionMessage tone="muted">Select a case to review it.</SectionMessage>
            ) : (
              <div className="space-y-3">
                <a
                  href={safeVacancyHref(selectedCase.vacancyUrl)}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-xs text-sky-400 underline"
                >
                  {selectedCase.vacancyUrl}
                </a>
                <pre className="max-h-40 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-400">
                  {JSON.stringify(selectedCase.evidenceSnapshot, null, 2)}
                </pre>
                <textarea
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  placeholder="Rationale (required)"
                  rows={3}
                  className="w-full rounded border border-slate-700 bg-slate-900 p-2 text-sm text-slate-200 placeholder:text-slate-600"
                />
                <div className="flex flex-wrap gap-2">
                  {MODERATION_DECISIONS.map((decision) => (
                    <button
                      key={decision}
                      type="button"
                      disabled={busy}
                      onClick={() => void decide(decision)}
                      className="rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                    >
                      {DECISION_LABEL[decision]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </AdminCard>
  );
}
