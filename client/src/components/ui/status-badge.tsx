import type { SVGProps } from "react";
import { Badge } from "./badge";
import { cn } from "../../lib/utils";

/**
 * PRD §18.4: trust status must never be conveyed by color alone. Every
 * status here renders a distinct icon shape *and* a text label *and* a
 * color — any one of the three still identifies the status on its own
 * (e.g. for a color-blind or monochrome-screenshot reader).
 *
 * Only the four statuses named in the MP-UI1 design brief are mapped.
 * Other trust_status values that exist in the schema (PENDING, SCORING,
 * FLAGGED, SCORING_FAILED, EXPIRED) aren't given colors here — extending
 * this map for them is a follow-up decision, not something to guess at.
 *
 * MP-UI2 adds automation_active/paused/stopped for the Automation card's
 * status display (data layer's AuthorizationStatus "authorized" maps to
 * the "Active" label here). These reuse the same three colors/icons as
 * the trust statuses above rather than inventing a second palette.
 *
 * MP-F2 adds fact_pending/confirmed/rejected for each extracted fact's
 * confirmation state (fact_confirmations.status) — again reusing the same
 * three colors/icons rather than a third palette.
 *
 * R3.1 adds severity_* (moderation_cases.severity: critical/high/medium/low,
 * mapped red/amber/blue/green by descending urgency) and moderation_* (the
 * five moderation_decisions.decision values), reusing the same four
 * palettes rather than a fifth/sixth one. moderation_request_info and
 * moderation_escalated share the under_review palette (same "in progress,
 * not yet resolved" semantic) — same "same color, different label"
 * precedent as apply_queued/apply_in_progress below.
 */
export type StatusBadgeStatus =
  | "verified"
  | "under_review"
  | "blocked"
  | "action_required"
  | "automation_active"
  | "automation_paused"
  | "automation_stopped"
  | "fact_pending"
  | "fact_confirmed"
  | "fact_rejected"
  | "apply_not_started"
  | "apply_queued"
  | "apply_in_progress"
  | "apply_action_required"
  | "apply_completed"
  | "apply_failed"
  | "severity_critical"
  | "severity_high"
  | "severity_medium"
  | "severity_low"
  | "moderation_cleared"
  | "moderation_flagged"
  | "moderation_blocked"
  | "moderation_request_info"
  | "moderation_escalated";

interface StatusConfig {
  label: string;
  bg: string;
  fg: string;
  Icon: (props: SVGProps<SVGSVGElement>) => JSX.Element;
}

function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.75V8l2.25 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function XCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PauseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <rect x="5" y="4" width="2" height="8" rx="0.75" fill="currentColor" />
      <rect x="9" y="4" width="2" height="8" rx="0.75" fill="currentColor" />
    </svg>
  );
}

const STATUS_CONFIG: Record<StatusBadgeStatus, StatusConfig> = {
  verified: {
    label: "Verified",
    // 8%, not a rounder 10-12%: keeps the tinted background close enough
    // to white that the -fg text/icon contrast ratios computed against
    // pure white (see each color's definition in styles.css) still hold —
    // status-under-review-fg has the thinnest margin (~4.64:1) of the four.
    bg: "bg-status-verified/8",
    fg: "text-status-verified-fg",
    Icon: CheckIcon,
  },
  under_review: {
    label: "Under review",
    bg: "bg-status-under-review/8",
    fg: "text-status-under-review-fg",
    Icon: ClockIcon,
  },
  blocked: {
    label: "Blocked",
    bg: "bg-status-blocked/8",
    fg: "text-status-blocked-fg",
    Icon: XCircleIcon,
  },
  action_required: {
    label: "Action required",
    bg: "bg-status-action-required/8",
    fg: "text-status-action-required-fg",
    Icon: PauseIcon,
  },
  automation_active: {
    label: "Active",
    bg: "bg-status-verified/8",
    fg: "text-status-verified-fg",
    Icon: CheckIcon,
  },
  automation_paused: {
    label: "Paused",
    bg: "bg-status-under-review/8",
    fg: "text-status-under-review-fg",
    Icon: PauseIcon,
  },
  automation_stopped: {
    label: "Stopped",
    bg: "bg-status-blocked/8",
    fg: "text-status-blocked-fg",
    Icon: XCircleIcon,
  },
  fact_pending: {
    label: "Pending review",
    bg: "bg-status-under-review/8",
    fg: "text-status-under-review-fg",
    Icon: ClockIcon,
  },
  fact_confirmed: {
    label: "Confirmed",
    bg: "bg-status-verified/8",
    fg: "text-status-verified-fg",
    Icon: CheckIcon,
  },
  fact_rejected: {
    label: "Rejected",
    bg: "bg-status-blocked/8",
    fg: "text-status-blocked-fg",
    Icon: XCircleIcon,
  },
  apply_not_started: {
    label: "Not started",
    bg: "bg-status-under-review/8",
    fg: "text-status-under-review-fg",
    Icon: ClockIcon,
  },
  apply_queued: {
    label: "Queued",
    bg: "bg-status-verified/8",
    fg: "text-status-verified-fg",
    Icon: CheckIcon,
  },
  apply_in_progress: {
    label: "In progress",
    bg: "bg-status-verified/8",
    fg: "text-status-verified-fg",
    Icon: CheckIcon,
  },
  apply_action_required: {
    label: "Action required",
    bg: "bg-status-action-required/8",
    fg: "text-status-action-required-fg",
    Icon: PauseIcon,
  },
  apply_completed: {
    label: "Completed",
    bg: "bg-status-verified/8",
    fg: "text-status-verified-fg",
    Icon: CheckIcon,
  },
  apply_failed: {
    label: "Failed",
    bg: "bg-status-blocked/8",
    fg: "text-status-blocked-fg",
    Icon: XCircleIcon,
  },
  severity_critical: {
    label: "Critical",
    bg: "bg-status-blocked/8",
    fg: "text-status-blocked-fg",
    Icon: XCircleIcon,
  },
  severity_high: {
    label: "High",
    bg: "bg-status-action-required/8",
    fg: "text-status-action-required-fg",
    Icon: PauseIcon,
  },
  severity_medium: {
    label: "Medium",
    bg: "bg-status-under-review/8",
    fg: "text-status-under-review-fg",
    Icon: ClockIcon,
  },
  severity_low: {
    label: "Low",
    bg: "bg-status-verified/8",
    fg: "text-status-verified-fg",
    Icon: CheckIcon,
  },
  moderation_cleared: {
    label: "Cleared",
    bg: "bg-status-verified/8",
    fg: "text-status-verified-fg",
    Icon: CheckIcon,
  },
  moderation_flagged: {
    label: "Flagged",
    bg: "bg-status-action-required/8",
    fg: "text-status-action-required-fg",
    Icon: PauseIcon,
  },
  moderation_blocked: {
    label: "Blocked",
    bg: "bg-status-blocked/8",
    fg: "text-status-blocked-fg",
    Icon: XCircleIcon,
  },
  moderation_request_info: {
    label: "Info requested",
    bg: "bg-status-under-review/8",
    fg: "text-status-under-review-fg",
    Icon: ClockIcon,
  },
  moderation_escalated: {
    label: "Escalated",
    bg: "bg-status-under-review/8",
    fg: "text-status-under-review-fg",
    Icon: ClockIcon,
  },
};

export interface StatusBadgeProps {
  status: StatusBadgeStatus;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const { label, bg, fg, Icon } = STATUS_CONFIG[status];

  return (
    <Badge className={cn(bg, fg, className)}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </Badge>
  );
}
