import { useEffect, useState } from "react";
import { ShieldAlert, LogOut } from "lucide-react";
import { APP_NAME } from "../../../shared/app";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { StatusBadge, type StatusBadgeStatus } from "../components/ui/status-badge";
import {
  getModerationQueue,
  submitModerationDecision,
  MODERATION_DECISIONS,
  type ModerationDecisionValue,
  type ModerationQueueEntry,
} from "../lib/moderation";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { EmployerClaimsQueuePanel } from "../panels/EmployerClaimsQueuePanel";

interface ModeratorPageProps {
  onLogout: () => void;
}

const SEVERITY_BADGE: Record<string, StatusBadgeStatus> = {
  critical: "severity_critical",
  high: "severity_high",
  medium: "severity_medium",
  low: "severity_low",
};

const DECISION_LABEL: Record<ModerationDecisionValue, string> = {
  cleared: "Clear",
  flagged: "Flag",
  blocked: "Block",
  request_info: "Request info",
  escalated: "Escalate",
};

/**
 * moderation_cases has no SLA/due-date column — showing time elapsed since
 * created_at is honest; a countdown-to-breach would require inventing an
 * SLA-duration policy that doesn't exist anywhere in the schema or PRD.
 */
function formatElapsed(createdAt: string): string {
  const elapsedMs = Date.now() - new Date(createdAt).getTime();
  const minutes = Math.floor(elapsedMs / 60_000);

  if (minutes < 60) {
    return `${Math.max(minutes, 0)}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

async function getAccessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

type ModeratorTab = "vacancies" | "employerClaims";

export function ModeratorPage({ onLogout }: ModeratorPageProps) {
  const [tab, setTab] = useState<ModeratorTab>("vacancies");
  const [queue, setQueue] = useState<ModerationQueueEntry[] | null>(null);
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

    const result = await getModerationQueue(accessToken);

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

  const selectedCase = queue?.find((entry) => entry.caseId === selectedCaseId) ?? null;

  function handleSelect(caseId: string) {
    setSelectedCaseId(caseId);
    setRationale("");
    setError(null);
  }

  async function handleDecide(decision: ModerationDecisionValue) {
    if (!selectedCase) {
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

  if (forbidden) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ios-bg p-6">
        <EmptyState
          icon={ShieldAlert}
          title="Access denied"
          description="You don't have moderator access to this console."
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ios-bg">
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-ios-separator bg-ios-card/80 px-6 backdrop-blur-md">
        <span className="text-base font-semibold text-black">{APP_NAME} — Moderator Console</span>
        <button
          type="button"
          onClick={onLogout}
          className="flex items-center gap-2 rounded-control px-3 py-1.5 text-sm font-medium text-black hover:bg-ios-bg"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Log out
        </button>
      </header>

      <div className="mx-auto flex max-w-[1200px] gap-2 px-6 pt-6">
        <Button variant={tab === "vacancies" ? "primary" : "secondary"} size="sm" onClick={() => setTab("vacancies")}>
          Vacancy queue
        </Button>
        <Button
          variant={tab === "employerClaims" ? "primary" : "secondary"}
          size="sm"
          onClick={() => setTab("employerClaims")}
        >
          Employer claims
        </Button>
      </div>

      {tab === "employerClaims" ? (
        <main className="mx-auto max-w-[1200px] p-6">
          <EmployerClaimsQueuePanel />
        </main>
      ) : (
      <main className="mx-auto grid max-w-[1200px] gap-6 p-6 lg:grid-cols-[380px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle id="queue-title">Risk queue{queue ? ` (${queue.length})` : ""}</CardTitle>
          </CardHeader>
          <CardContent aria-labelledby="queue-title">
            {queue === null ? null : queue.length === 0 ? (
              <EmptyState icon={ShieldAlert} title="Queue is empty" description="No open cases right now." />
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
                      <div className="flex items-center justify-between gap-2">
                        <StatusBadge status={SEVERITY_BADGE[entry.severity] ?? "severity_medium"} />
                        <span className="text-xs text-ios-text-secondary">{formatElapsed(entry.createdAt)}</span>
                      </div>
                      <p className="mt-1.5 text-sm font-medium text-black">{entry.vacancyTitle || "(untitled)"}</p>
                      <p className="text-xs text-ios-text-secondary">{entry.sourceType}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle id="case-title">Case detail</CardTitle>
          </CardHeader>
          <CardContent aria-labelledby="case-title">
            {error && (
              <p role="alert" className="mb-3 text-sm text-status-blocked-fg">
                {error}
              </p>
            )}

            {!selectedCase ? (
              <EmptyState icon={ShieldAlert} title="No case selected" description="Select a case from the queue to review it." />
            ) : (
              <div className="space-y-4">
                <div>
                  <a
                    href={selectedCase.vacancyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[15px] font-medium text-ios-blue hover:underline"
                  >
                    {selectedCase.vacancyTitle || "(untitled)"}
                  </a>
                  <p className="text-sm text-ios-text-secondary">
                    Source: {selectedCase.sourceType} · In queue for {formatElapsed(selectedCase.createdAt)}
                  </p>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-black">Evidence</h3>
                  <pre className="mt-1 max-h-64 overflow-auto rounded-control bg-ios-bg p-3 text-xs text-black">
                    {JSON.stringify(selectedCase.evidenceSnapshot, null, 2)}
                  </pre>
                </div>

                <div>
                  <label htmlFor="rationale" className="text-sm font-medium text-black">
                    Rationale
                  </label>
                  <textarea
                    id="rationale"
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
      </main>
      )}
    </div>
  );
}
