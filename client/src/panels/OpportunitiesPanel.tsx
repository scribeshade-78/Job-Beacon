import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { StatusBadge } from "../components/ui/status-badge";
import {
  listOpportunities,
  type OpportunityFitAnalysis,
  type OpportunitySummary,
} from "../lib/opportunities";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { safeVacancyHref } from "./shared";
import { formatSalary } from "../lib/opportunities";
import { formatDistanceToNow } from "date-fns";

const MAX_MISSING_SKILLS_SHOWN = 5;
const MAX_TOP_REASONS_SHOWN = 3;

function priorityBadge(fit: OpportunityFitAnalysis): { label: string; className: string } {
  if (fit.eligibilityCapped) {
    return { label: "Not eligible", className: "bg-red-100 text-red-800" };
  }
  const score = fit.priority.score;
  if (score === null) {
    return { label: "Priority —", className: "bg-ios-separator text-ios-text-secondary" };
  }
  if (score >= 70) {
    return { label: `Priority ${score}`, className: "bg-green-100 text-green-800" };
  }
  if (score >= 40) {
    return { label: `Priority ${score}`, className: "bg-amber-100 text-amber-800" };
  }
  return { label: `Priority ${score}`, className: "bg-ios-separator text-ios-text-secondary" };
}

function FitSection({ fit }: { fit: OpportunityFitAnalysis | null }) {
  if (fit === null) {
    return <p className="mt-2 text-xs text-ios-text-secondary italic">Fit analysis pending</p>;
  }

  const badge = priorityBadge(fit);
  const shownSkills = fit.missingEvidence.slice(0, MAX_MISSING_SKILLS_SHOWN);
  const extraSkills = fit.missingEvidence.length - shownSkills.length;

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${badge.className}`}>{badge.label}</span>
        <span className="text-xs text-ios-text-secondary">
          Technical fit {fit.technicalFitScore ?? "—"}
          {fit.technicalFitScore === null && !fit.jdTextAvailable ? " (no job description text)" : ""}
        </span>
        <span className="text-xs text-ios-text-secondary">
          Eligibility {fit.practicalEligibilityScore ?? "—"}
        </span>
        {fit.eligibilityCapped && fit.priority.uncappedScore !== null && (
          <span className="text-xs text-ios-text-secondary">
            (would rank {fit.priority.uncappedScore} if eligible)
          </span>
        )}
      </div>

      {fit.hardBlockers.length > 0 && (
        <div role="alert" className="rounded bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800">
          <span className="font-medium">Not eligible.</span>{" "}
          {fit.hardBlockers.map((b) => b.detail).join(" ")}
        </div>
      )}

      {shownSkills.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ios-text-secondary">Missing:</span>
          {shownSkills.map((skill, i) => (
            <span key={`${skill}-${i}`} className="px-2 py-0.5 bg-ios-separator rounded text-xs">
              {skill}
            </span>
          ))}
          {extraSkills > 0 && (
            <span className="text-xs text-ios-text-secondary">+{extraSkills} more</span>
          )}
        </div>
      )}

      {fit.topReasons.length > 0 && (
        <ul className="list-disc list-inside text-xs text-ios-text-secondary space-y-0.5">
          {fit.topReasons.slice(0, MAX_TOP_REASONS_SHOWN).map((reason, i) => (
            <li key={`${reason}-${i}`}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
        {opportunities !== null && opportunities.length > 0 && (
          <p className="text-xs text-ios-text-secondary mb-3">Sorted by priority</p>
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
                  <FitSection fit={opp.fitAnalysis} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}