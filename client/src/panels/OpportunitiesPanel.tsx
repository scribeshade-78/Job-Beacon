import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { StatusBadge } from "../components/ui/status-badge";
import { listOpportunities, type OpportunitySummary } from "../lib/opportunities";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { safeVacancyHref } from "./shared";
import { formatSalary } from "../lib/opportunities";
import { formatDistanceToNow } from "date-fns";

function trustStatusToBadge(status: OpportunitySummary["trustStatus"]): "verified" | "under_review" | "blocked" | "action_required" {
  switch (status) {
    case "VERIFIED":
    case "VERIFIED_INCOMPLETE":
      return "verified";
    case "UNDER_REVIEW":
    case "FLAGGED":
      return "under_review";
    case "BLOCKED":
    case "EXPIRED_REMOVED":
      return "blocked";
    case "ACTION_REQUIRED":
      return "action_required";
  }
}

function autoApplyStatusBadge(status: OpportunitySummary["autoApplyStatus"]): "apply_not_started" | "apply_queued" | "apply_in_progress" | "apply_action_required" | "apply_completed" | "apply_failed" {
  switch (status) {
    case "not_started":
      return "apply_not_started";
    case "queued":
      return "apply_queued";
    case "in_progress":
      return "apply_in_progress";
    case "action_required":
      return "apply_action_required";
    case "completed":
      return "apply_completed";
    case "failed":
      return "apply_failed";
  }
}

export function OpportunitiesPanel() {
  const [opportunities, setOpportunities] = useState<OpportunitySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    listOpportunities(getSupabaseBrowserClient()).then((result) => {
      if (cancelled) return;

      setLoading(false);
      if (result.kind === "success") {
        setOpportunities(result.opportunities);
      } else {
        setError(result.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle id="opportunities-title">Opportunities</CardTitle>
        </CardHeader>
        <CardContent aria-labelledby="opportunities-title">
          <p className="text-sm text-ios-text-secondary animate-pulse">Loading opportunities…</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle id="opportunities-title">Opportunities</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="opportunities-title">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg mb-4">
            {error}
          </p>
        )}
        {opportunities?.length === 0 && (
          <p className="text-sm text-ios-text-secondary">No verified opportunities found.</p>
        )}
        <ul className="space-y-4" role="list" aria-label="Verified job opportunities">
          {opportunities?.map((opp) => (
            <li key={opp.id} className="border border-ios-separator rounded-lg p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex-1 min-w-0">
                  <a
                    href={safeVacancyHref(opp.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-ios-blue hover:underline truncate block"
                  >
                    {opp.title}
                  </a>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ios-text-secondary">
                    {opp.companyName && (
                      <span className="font-medium text-black">{opp.companyName}</span>
                    )}
                    {opp.companyDomain && (
                      <span className="text-ios-text-secondary">· {opp.companyDomain}</span>
                    )}
                    <span>· {opp.location}</span>
                    {opp.remoteType && (
                      <span className="px-2 py-0.5 bg-ios-separator rounded text-xs">{opp.remoteType}</span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <StatusBadge status={trustStatusToBadge(opp.trustStatus)} />
                    {opp.trustScore !== null && (
                      <span className="text-xs text-ios-text-secondary">Score: {opp.trustScore}</span>
                    )}
                    <span className="text-xs text-ios-text-secondary">
                      {formatSalary(opp.salary)}
                    </span>
                    <span className="text-xs text-ios-text-secondary">
                      Discovered {formatDistanceToNow(new Date(opp.discoveredAt), { addSuffix: true })}
                    </span>
                    <StatusBadge status={autoApplyStatusBadge(opp.autoApplyStatus)} className="text-xs" />
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}