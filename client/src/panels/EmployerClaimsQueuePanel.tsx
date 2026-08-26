import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { StatusBadge } from "../components/ui/status-badge";
import {
  getEmployerClaimsQueue,
  submitEmployerClaimDecision,
  EMPLOYER_CLAIM_DECISIONS,
  type EmployerClaimDecisionValue,
  type EmployerClaimQueueEntry,
} from "../lib/employer";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

const DECISION_LABEL: Record<EmployerClaimDecisionValue, string> = {
  verified: "Verify",
  rejected: "Reject",
};

async function getAccessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

export function EmployerClaimsQueuePanel() {
  const [queue, setQueue] = useState<EmployerClaimQueueEntry[] | null>(null);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
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

    const result = await getEmployerClaimsQueue(accessToken);

    if (result.kind === "forbidden") {
      setForbidden(true);
    } else if (result.kind === "error") {
      setError(result.message);
    } else {
      setQueue(result.entries);
      setSelectedClaimId((current) => (current && result.entries.some((entry) => entry.id === current) ? current : null));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedClaim = queue?.find((entry) => entry.id === selectedClaimId) ?? null;

  function handleSelect(claimId: string) {
    setSelectedClaimId(claimId);
    setRationale("");
    setError(null);
  }

  async function handleDecide(decision: EmployerClaimDecisionValue) {
    if (!selectedClaim) {
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

    const result = await submitEmployerClaimDecision(selectedClaim.id, decision, rationale.trim(), accessToken);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      setRationale("");
      setSelectedClaimId(null);
      await refresh();
    }

    setBusy(false);
  }

  if (forbidden) {
    return (
      <EmptyState icon={Building2} title="Access denied" description="You don't have moderator access to this queue." />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle id="employer-queue-title">Pending claims{queue ? ` (${queue.length})` : ""}</CardTitle>
        </CardHeader>
        <CardContent aria-labelledby="employer-queue-title">
          {queue === null ? null : queue.length === 0 ? (
            <EmptyState icon={Building2} title="Queue is empty" description="No pending employer claims right now." />
          ) : (
            <ul className="space-y-2">
              {queue.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(entry.id)}
                    aria-current={entry.id === selectedClaimId ? "true" : undefined}
                    className={`w-full rounded-control border p-3 text-left transition-colors ${
                      entry.id === selectedClaimId
                        ? "border-ios-blue bg-ios-blue/10"
                        : "border-ios-separator bg-ios-card hover:bg-ios-bg"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-black">{entry.companyName}</span>
                      {entry.domainVerified && <StatusBadge status="verified" />}
                    </div>
                    <p className="text-xs text-ios-text-secondary">
                      {entry.representativeName} — {entry.representativeRole}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="employer-claim-detail-title">Claim detail</CardTitle>
        </CardHeader>
        <CardContent aria-labelledby="employer-claim-detail-title">
          {error && (
            <p role="alert" className="mb-3 text-sm text-status-blocked-fg">
              {error}
            </p>
          )}

          {!selectedClaim ? (
            <EmptyState icon={Building2} title="No claim selected" description="Select a claim from the queue to review it." />
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-[15px] font-medium text-black">{selectedClaim.companyName}</p>
                <p className="text-sm text-ios-text-secondary">
                  {selectedClaim.representativeName} — {selectedClaim.representativeRole}
                </p>
                <p className="text-sm text-ios-text-secondary">
                  Corporate-domain match:{" "}
                  {selectedClaim.domainVerified ? "yes (account email domain matches)" : "no — verify independently"}
                </p>
              </div>

              {selectedClaim.evidence && (
                <div>
                  <h3 className="text-sm font-medium text-black">Evidence</h3>
                  <p className="mt-1 whitespace-pre-wrap rounded-control bg-ios-bg p-3 text-sm text-black">
                    {selectedClaim.evidence}
                  </p>
                </div>
              )}

              <div>
                <label htmlFor="employer-decision-rationale" className="text-sm font-medium text-black">
                  Rationale
                </label>
                <textarea
                  id="employer-decision-rationale"
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  disabled={busy}
                  rows={3}
                  className="mt-1 w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2.5 text-[15px] text-black placeholder:text-ios-text-secondary focus-visible:border-ios-blue disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="Required — explain the decision for the audit record."
                />
              </div>

              <div className="flex flex-wrap gap-2">
                {EMPLOYER_CLAIM_DECISIONS.map((decision) => (
                  <Button
                    key={decision}
                    size="sm"
                    variant={decision === "verified" ? "primary" : "destructive"}
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
