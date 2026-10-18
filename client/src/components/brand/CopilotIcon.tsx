import { useId } from "react";
import { cn } from "../../lib/utils";

/**
 * "Paper Airplane / Upward Growth" — the Career Copilot mark.
 *
 * FACETED, NOT GRADIENT-WASHED. Each polygon carries its own gradient so the folded planes read as
 * separate surfaces, which is what makes an origami shape look folded rather than painted. The
 * crease from nose to belly is a thin translucent line for the same reason.
 *
 * NO DARK-MODE OVERRIDE. The deep-navy facet is the darkest thing in the mark, but it sits on a
 * saturated blue-to-cyan field rather than on the page background, so it keeps its contrast on a
 * light or dark surface alike. Only the wordmark needed flipping.
 */
export interface CopilotIconProps {
  className?: string;
  title?: string;
}

export function CopilotIcon({ className, title = "Career Copilot" }: CopilotIconProps) {
  const uid = useId().replace(/:/g, "");
  const wing = "cp-wing-" + uid;
  const body = "cp-body-" + uid;
  const keel = "cp-keel-" + uid;

  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
      className={cn("block", className)}
      focusable="false"
    >
      <defs>
        <linearGradient id={wing} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#0B2A6F" />
          <stop offset="100%" stopColor="#1E63E9" />
        </linearGradient>
        <linearGradient id={body} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1E63E9" />
          <stop offset="100%" stopColor="#22D3C5" />
        </linearGradient>
        <linearGradient id={keel} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#0B2A6F" />
          <stop offset="100%" stopColor="#3B82F6" />
        </linearGradient>
      </defs>

      {/* Upper wing. */}
      <polygon points="58,6 4,34 32,40" fill={"url(#" + wing + ")"} />
      {/* Body / right wing. */}
      <polygon points="58,6 32,40 46,52" fill={"url(#" + body + ")"} />
      {/* Keel. */}
      <polygon points="4,34 32,40 24,50" fill={"url(#" + keel + ")"} />

      {/* The fold: nose to belly, faint so it reads as a crease rather than a crack. */}
      <line x1="58" y1="6" x2="32" y2="40" stroke="#FFFFFF" strokeOpacity="0.28" strokeWidth="1" />

      {/* Particles and speed dots trailing down-left. */}
      <polygon points="17,50 21,57 12,56" fill={"url(#" + body + ")"} opacity="0.9" />
      <polygon points="9,57 13,62 5,61" fill={"url(#" + keel + ")"} opacity="0.8" />
      <circle cx="22" cy="60" r="1.6" fill="#22D3C5" />
      <circle cx="8" cy="52" r="1.3" fill="#1E63E9" />
      <circle cx="14" cy="62" r="1.1" fill="#3B82F6" opacity="0.9" />
    </svg>
  );
}
