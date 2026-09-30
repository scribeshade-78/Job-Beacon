/**
 * The signals a listing card and the job detail page must agree on.
 *
 * Extracted from OpportunitiesPanel when the internal job detail page was
 * added: the trust warnings, the fit/eligibility block and the source
 * attribution are the SAME claims in both places, and a second copy of this
 * copy is exactly how the two surfaces would drift into telling a candidate
 * different things about one listing.
 */

import type { StatusBadgeStatus } from "./ui/status-badge";
import type {
  OpportunityFitAnalysis,
  OpportunitySummary,
  OpportunityTrustStatus,
} from "../lib/opportunities";

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

export function FitSection({ fit }: { fit: OpportunityFitAnalysis | null }) {
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

/**
 * An opportunity whose source could not be established as the employer's own
 * system of record (trust_status UNDER_REVIEW — every aggregator-tier source
 * lands here, see 20260917120000). Treated as "show, but never silently":
 * the card is rendered with a warning badge and an explicit explanation
 * rather than being hidden, because a relevant job the candidate cannot see
 * is its own failure mode.
 */
/**
 * The source's name as a candidate should read it.
 *
 * A lookup rather than a title-case helper, because source_code is an internal
 * identifier: "usajobs" title-cased is "Usajobs", and this repository's own
 * product naming for that source is USAJOBS. Unknown sources fall back to the
 * raw code, which is at least true.
 */
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  remotive: "Remotive",
  jooble: "Jooble",
  usajobs: "USAJOBS",
  adzuna: "Adzuna",
  greenhouse: "Greenhouse",
  lever: "Lever",
  local_fixture: "the local fixture",
};

export function formatSourceName(sourceCode: string): string {
  return SOURCE_DISPLAY_NAMES[sourceCode] ?? sourceCode;
}

/**
 * UNDER_REVIEW — the source could not be established as the employer's own
 * system of record. Distinct from VERIFIED_INCOMPLETE, which is "we have the
 * listing but not every detail": the two get different badges and different
 * explanatory copy below the card, because they are different claims.
 */
export function isUnverifiedSource(status: OpportunityTrustStatus): boolean {
  return status !== "VERIFIED" && status !== "VERIFIED_INCOMPLETE";
}

/** VERIFIED_INCOMPLETE — a real listing with unconfirmed non-critical details. */
export function isPartiallyVerified(status: OpportunityTrustStatus): boolean {
  return status === "VERIFIED_INCOMPLETE";
}

export function trustStatusToBadge(status: OpportunityTrustStatus): StatusBadgeStatus {
  switch (status) {
    case "VERIFIED":
      return "verified";
    case "VERIFIED_INCOMPLETE":
      // Task Y: no longer shares the green "Verified" badge. These listings are
      // real and linkable but their non-critical details were never confirmed,
      // and showing them as fully verified told the candidate otherwise.
      return "partially_verified";
    case "UNDER_REVIEW":
      // "Unverified source", not the generic "Under review": this label is
      // candidate-facing copy about the listing's provenance, and "under
      // review" reads as an internal moderation state.
      return "unverified_source";
    case "FLAGGED":
      return "under_review";
    case "BLOCKED":
    case "EXPIRED_REMOVED":
      return "blocked";
    case "ACTION_REQUIRED":
      return "action_required";
  }
}

export function autoApplyStatusBadge(status: OpportunitySummary["autoApplyStatus"]): StatusBadgeStatus {
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


/**
 * The trust warnings, rendered identically wherever a listing is shown.
 *
 * Two different claims, so two different sentences rather than one shared
 * "unverified" wording: UNDER_REVIEW is "we cannot confirm who is behind this
 * listing", VERIFIED_INCOMPLETE is "the listing is real, some detail is
 * missing".
 */
export function TrustWarnings({ trustStatus }: { trustStatus: OpportunityTrustStatus }) {
  if (isUnverifiedSource(trustStatus)) {
    return (
      <p
        role="note"
        className="mt-3 rounded border border-status-under-review/40 bg-status-under-review/8 px-3 py-2 text-xs text-status-under-review-fg"
      >
        <span className="font-semibold">We haven’t verified this employer or listing.</span>{" "}
        It came from a third-party job board we can’t confirm against the employer’s own
        site, so the details and the salary shown may be out of date. Confirm everything on
        the source site before you apply or share any personal information.
      </p>
    );
  }

  if (isPartiallyVerified(trustStatus)) {
    return (
      <p
        role="note"
        className="mt-3 rounded border border-status-under-review/40 bg-status-under-review/8 px-3 py-2 text-xs text-status-under-review-fg"
      >
        <span className="font-semibold">Some details aren’t confirmed.</span>{" "}
        This listing is real, but its source doesn’t publish the employer’s own website,
        a location or a salary we can check, so those fields may be absent rather than
        wrong. Open the original posting to confirm anything you’re relying on.
      </p>
    );
  }

  return null;
}

/**
 * The page-level explanation of the trust badges.
 *
 * WHY IT IS NOT PER CARD. Every unverified listing repeated the same paragraph,
 * so a page of 25 cards was 25 identical warnings and the differences between
 * the jobs were buried. The card keeps the compact badge (StatusBadge renders a
 * distinct icon AND a label, never colour alone); the explanation lives here
 * once. The detail page keeps the full wording, where it can be read next to the
 * listing it actually describes.
 */
export function TrustNoticeBanner() {
  return (
    <div
      role="note"
      className="mb-4 rounded-control border border-status-under-review/40 bg-status-under-review/8 px-3 py-2.5 text-xs text-status-under-review-fg"
    >
      <p>
        <span className="font-semibold">Some listings come from sources we can’t confirm.</span>{" "}
        A listing marked <span className="font-semibold">Unverified source</span> came from a
        third-party job board we can’t check against the employer’s own site, so its details
        and salary may be out of date. A listing marked{" "}
        <span className="font-semibold">Partly verified</span> is real, but some details are
        unconfirmed. Open a job to read the full warning, and confirm anything you rely on at the
        source before you apply or share personal information.
      </p>
    </div>
  );
}
