import { useEffect, useState } from "react";
import { FileEdit } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import {
  getCompanyFactCorrectionsQueue,
  submitCorrectionDecision,
  CORRECTABLE_FIELD_LABELS,
  CORRECTION_DECISIONS,
  type CorrectionDecisionValue,
  type CompanyFactCorrectionQueueEntry,
} from "../lib/companyFactCorrections";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

const DECISION_LABEL: Record<CorrectionDecisionValue, string> = {
  approved: "Approve",
  rejected: "Reject",
};

async function getAccessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

export function CompanyFactCorrectionsQueuePanel() {
  const [queue, setQueue] = useState<CompanyFactCorrectionQueueEntry[] | null>(null);
  const [selectedCorrectionId, setSelectedCorrectionId] = useState<string | null>(null);
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

    const result = await getCompanyFactCorrectionsQueue(accessToken);

    if (result.kind === "forbidden") {
      setForbidden(true);
    } else if (result.kind === "error") {
      setError(result.message);
    } else {
      setQueue(result.entries);
      setSelectedCorrectionId((current) =>
        current && result.entries.some((entry) => entry.id === current) ? current : null,
      );
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedCorrection = queue?.find((entry) => entry.id === selectedCorrectionId) ?? null;

  function handleSelect(correctionId: string) {
    setSelectedCorrectionId(correctionId);
    setRationale("");
    setError(null);
  }

  async function handleDecide(decision: CorrectionDecisionValue) {
    if (!selectedCorrection) {
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

    const result = await submitCorrectionDecision(selectedCorrection.id, decision, rationale.trim(), accessToken);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      setRationale("");
      setSelectedCorrectionId(null);
      await refresh();
    }

    setBusy(false);
  }

  if (forbidden) {
    return (
      <EmptyState icon={FileEdit} title="Access denied" description="You don't have moderator access to this queue." />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle id="corrections-queue-title">Pending corrections{queue ? ` (${queue.length})` : ""}</CardTitle>
        </CardHeader>
        <CardContent aria-labelledby="corrections-queue-title">
          {queue === null ? null : queue.length === 0 ? (
            <EmptyState icon={FileEdit} title="Queue is empty" description="No pending fact corrections right now." />
          ) : (
            <ul className="space-y-2">
              {queue.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(entry.id)}
                    aria-current={entry.id === selectedCorrectionId ? "true" : undefined}
                    className={`w-full rounded-control border p-3 text-left transition-colors ${
                      entry.id === selectedCorrectionId
                        ? "border-ios-blue bg-ios-blue/10"
                        : "border-ios-separator bg-ios-card hover:bg-ios-bg"
                    }`}
                  >
                    <p className="text-sm font-medium text-black">{entry.companyName}</p>
                    <p className="text-xs text-ios-text-secondary">{CORRECTABLE_FIELD_LABELS[entry.fieldName]}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="correction-detail-title">Correction detail</CardTitle>
        </CardHeader>
        <CardContent aria-labelledby="correction-detail-title">
          {error && (
            <p role="alert" className="mb-3 text-sm text-status-blocked-fg">
              {error}
            </p>
          )}

          {!selectedCorrection ? (
            <EmptyState
              icon={FileEdit}
              title="No correction selected"
              description="Select a correction from the queue to review it."
            />
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-[15px] font-medium text-black">{selectedCorrection.companyName}</p>
                <p className="text-sm text-ios-text-secondary">{CORRECTABLE_FIELD_LABELS[selectedCorrection.fieldName]}</p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <h3 className="font-medium text-black">Current value</h3>
                  <p className="text-ios-text-secondary">{selectedCorrection.currentValue ?? "(not set)"}</p>
                </div>
                <div>
                  <h3 className="font-medium text-black">Proposed value</h3>
                  <p className="text-black">{selectedCorrection.proposedValue}</p>
                </div>
              </div>

              {selectedCorrection.evidence && (
                <div>
                  <h3 className="text-sm font-medium text-black">Evidence</h3>
                  <p className="mt-1 whitespace-pre-wrap rounded-control bg-ios-bg p-3 text-sm text-black">
                    {selectedCorrection.evidence}
                  </p>
                </div>
              )}

              <div>
                <label htmlFor="correction-decision-rationale" className="text-sm font-medium text-black">
                  Rationale
                </label>
                <textarea
                  id="correction-decision-rationale"
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  disabled={busy}
                  rows={3}
                  className="mt-1 w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2.5 text-[15px] text-black placeholder:text-ios-text-secondary focus-visible:border-ios-blue disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="Required — explain the decision for the audit record."
                />
              </div>

              <div className="flex flex-wrap gap-2">
                {CORRECTION_DECISIONS.map((decision) => (
                  <Button
                    key={decision}
                    size="sm"
                    variant={decision === "approved" ? "primary" : "destructive"}
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
