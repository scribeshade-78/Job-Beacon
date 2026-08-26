import { useEffect, useState } from "react";
import { Scale } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { getAppealsQueue, type AppealQueueEntry } from "../lib/employerAppeals";
import { submitModerationDecision, MODERATION_DECISIONS, type ModerationDecisionValue } from "../lib/moderation";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

const DECISION_LABEL: Record<ModerationDecisionValue, string> = {
  cleared: "Overturn (clear)",
  flagged: "Uphold (flag)",
  blocked: "Uphold (block)",
  request_info: "Request info",
  escalated: "Escalate",
};

async function getAccessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

export function AppealsQueuePanel() {
  const [queue, setQueue] = useState<AppealQueueEntry[] | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const accessToken = await getAccessToken();

    if (!accessToken) {
      setForbidden(true);
      return;
    }

    const result = await getAppealsQueue(accessToken);

    if (result.kind === "forbidden") {
      setForbidden(true);
    } else if (result.kind === "error") {
      setError(result.message);
    } else {
      setQueue(result.entries);
      setSelectedCaseId((current) => (current && result.entries.some((entry) => entry.caseId === current) ? current : null));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedAppeal = queue?.find((entry) => entry.caseId === selectedCaseId) ?? null;

  function handleSelect(caseId: string) {
    setSelectedCaseId(caseId);
    setRationale("");
    setError(null);
  }

  async function handleDecide(decision: ModerationDecisionValue) {
    if (!selectedAppeal) {
      return;
    }

    if (rationale.trim() === "") {
      setError("Rationale is required.");
      return;
    }

    setBusy(true);
    setError(null);

    const accessToken = await getAccessToken();

    if (!accessToken) {
      setForbidden(true);
      setBusy(false);
      return;
    }

    const result = await submitModerationDecision(
      selectedAppeal.caseId,
      decision,
      rationale.trim(),
      accessToken,
      fetch,
      selectedAppeal.appealId,
    );

    if (result.kind === "error") {
      setError(result.message);
    } else {
      setRationale("");
      setSelectedCaseId(null);
      await refresh();
    }

    setBusy(false);
  }

  if (forbidden) {
    return <EmptyState icon={Scale} title="Access denied" description="You don't have moderator access to this queue." />;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle id="appeals-queue-title">Pending appeals{queue ? ` (${queue.length})` : ""}</CardTitle>
        </CardHeader>
        <CardContent aria-labelledby="appeals-queue-title">
          {queue === null ? null : queue.length === 0 ? (
            <EmptyState icon={Scale} title="Queue is empty" description="No pending appeals right now." />
          ) : (
            <ul className="space-y-2">
              {queue.map((entry) => (
                <li key={entry.caseId}>
                  <button
                    type="button"
                    onClick={() => handleSelect(entry.caseId)}
                    aria-current={entry.caseId === selectedCaseId ? "true" : undefined}
                    className={`w-full rounded-control border p-3 text-left transition-colors ${
                      entry.caseId === selectedCaseId
                        ? "border-ios-blue bg-ios-blue/10"
                        : "border-ios-separator bg-ios-card hover:bg-ios-bg"
                    }`}
                  >
                    <p className="text-sm font-medium text-black">{entry.vacancyTitle || "(untitled)"}</p>
                    {entry.evidenceDeadline && (
                      <p className="text-xs text-ios-text-secondary">Evidence due {entry.evidenceDeadline}</p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="appeal-detail-title">Appeal detail</CardTitle>
        </CardHeader>
        <CardContent aria-labelledby="appeal-detail-title">
          {error && (
            <p role="alert" className="mb-3 text-sm text-status-blocked-fg">
              {error}
            </p>
          )}

          {!selectedAppeal ? (
            <EmptyState icon={Scale} title="No appeal selected" description="Select an appeal from the queue to review it." />
          ) : (
            <div className="space-y-4">
              <div>
                <a
                  href={selectedAppeal.vacancyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[15px] font-medium text-ios-blue hover:underline"
                >
                  {selectedAppeal.vacancyTitle || "(untitled)"}
                </a>
              </div>

              <div>
                <h3 className="text-sm font-medium text-black">Original decision</h3>
                <p className="mt-1 rounded-control bg-ios-bg p-3 text-sm text-black">
                  {selectedAppeal.originalDecisionRationale}{" "}
                  <span className="text-ios-text-secondary">(policy {selectedAppeal.originalDecisionPolicyVersion})</span>
                </p>
              </div>

              <div>
                <h3 className="text-sm font-medium text-black">Employer's appeal</h3>
                <p className="mt-1 whitespace-pre-wrap rounded-control bg-ios-bg p-3 text-sm text-black">
                  {selectedAppeal.appealRationale}
                </p>
                {selectedAppeal.appealEvidence != null && (
                  <pre className="mt-1 max-h-48 overflow-auto rounded-control bg-ios-bg p-3 text-xs text-black">
                    {JSON.stringify(selectedAppeal.appealEvidence, null, 2)}
                  </pre>
                )}
              </div>

              <div>
                <label htmlFor="appeal-decision-rationale" className="text-sm font-medium text-black">
                  Rationale
                </label>
                <textarea
                  id="appeal-decision-rationale"
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  disabled={busy}
                  rows={3}
                  className="mt-1 w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2.5 text-[15px] text-black placeholder:text-ios-text-secondary focus-visible:border-ios-blue disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="Required — explain the decision for the audit record."
                />
              </div>

              <div className="flex flex-wrap gap-2">
                {MODERATION_DECISIONS.map((decision) => (
                  <Button
                    key={decision}
                    size="sm"
                    variant={decision === "cleared" ? "primary" : decision === "blocked" ? "destructive" : "secondary"}
                    disabled={busy}
                    onClick={() => void handleDecide(decision)}
                  >
                    {DECISION_LABEL[decision]}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
