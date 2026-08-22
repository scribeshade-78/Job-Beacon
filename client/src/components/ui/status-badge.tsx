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
 */
export type StatusBadgeStatus =
  | "verified"
  | "under_review"
  | "blocked"
  | "action_required"
  | "automation_active"
  | "automation_paused"
  | "automation_stopped";

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
