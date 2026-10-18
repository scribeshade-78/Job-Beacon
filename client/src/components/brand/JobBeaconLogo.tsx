import { useId } from "react";
import { cn } from "../../lib/utils";

/**
 * "Cyber Signal" — the JobBeacon wordmark and transmission-tower mark.
 *
 * VECTOR, NOT A BITMAP, because it appears at three sizes (h-8 in the mobile bar, h-9 in the
 * sidebar, and the full lockup with the tagline) and a PNG would either blur or need three files.
 *
 * THE WORDMARK IS SVG TEXT, not paths. It inherits Inter from the app, so it stays crisp and the
 * letters are selectable for screen readers through the svg's aria-label; converting to paths would
 * freeze the font but add ~8KB of outlines per weight and lose nothing visually at these sizes.
 *
 * DARK MODE IS CLASS-SCOPED, NOT AN OS MEDIA QUERY. The navy "Job" disappears on a dark surface, so
 * both wordmark spans carry a class that flips under a `.dark` ancestor (see styles.css). Tailwind's
 * `dark:` variant follows prefers-color-scheme, and this app has no dark theme yet — using it would
 * paint the wordmark white on the current light sidebar for anyone whose OS is dark.
 */
export interface JobBeaconLogoProps {
  className?: string;
  /** The tracked-out "ILLUMINATE YOUR CAREER" line. Off by default; the sidebar has no room. */
  showTagline?: boolean;
  /** Accessible name. Visible text is not enough on its own for a mark that includes a glyph. */
  title?: string;
}

export function JobBeaconLogo({ className, showTagline = false, title = "JobBeacon" }: JobBeaconLogoProps) {
  // useId keeps the gradient unique when the logo is mounted twice (sidebar + mobile bar); colons
  // are stripped because they are legal in ids but awkward inside url(#...).
  const uid = useId().replace(/:/g, "");
  const gradientId = "jb-signal-" + uid;

  return (
    <svg
      viewBox="0 0 336 84"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
      className={cn("block w-auto", className)}
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#0B2A6F" />
          <stop offset="52%" stopColor="#1E63E9" />
          <stop offset="100%" stopColor="#22D3C5" />
        </linearGradient>
      </defs>

      {/* Radiating signal waves — three arcs each side, fading outward. */}
      <g fill="none" stroke={"url(#" + gradientId + ")"} strokeLinecap="round">
        <path d="M30 28 A18 18 0 0 0 30 56" strokeWidth="4.5" opacity="0.95" />
        <path d="M24 22 A26 26 0 0 0 24 62" strokeWidth="4.5" opacity="0.6" />
        <path d="M18 16 A34 34 0 0 0 18 68" strokeWidth="4.5" opacity="0.3" />
        <path d="M54 28 A18 18 0 0 1 54 56" strokeWidth="4.5" opacity="0.95" />
        <path d="M60 22 A26 26 0 0 1 60 62" strokeWidth="4.5" opacity="0.6" />
        <path d="M66 16 A34 34 0 0 1 66 68" strokeWidth="4.5" opacity="0.3" />
      </g>

      {/* The tower: two legs, a cross brace, and the beacon arch at the apex. */}
      <g fill="none" stroke={"url(#" + gradientId + ")"} strokeLinecap="round" strokeLinejoin="round">
        <path d="M42 30 L26 76" strokeWidth="5" />
        <path d="M42 30 L58 76" strokeWidth="5" />
        <path d="M32 52 L52 66" strokeWidth="4" opacity="0.9" />
        <path d="M52 52 L32 66" strokeWidth="4" opacity="0.9" />
        <path d="M36 30 V24 A6 6 0 0 1 48 24 V30" strokeWidth="4.5" />
      </g>

      {/* Four-point star above the arch. */}
      <path
        d="M42 1 C43.6 6.4 45.6 8.4 51 10 C45.6 11.6 43.6 13.6 42 19 C40.4 13.6 38.4 11.6 33 10 C38.4 8.4 40.4 6.4 42 1 Z"
        fill={"url(#" + gradientId + ")"}
      />

      {/* Wordmark. "Job" is midnight navy, "Beacon" royal blue; both flip under .dark. */}
      <text
        x="92"
        y="54"
        fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
        fontSize="40"
        fontWeight="700"
        letterSpacing="-1.2"
      >
        <tspan className="jb-wordmark-primary">Job</tspan>
        <tspan className="jb-wordmark-accent">Beacon</tspan>
      </text>

      {showTagline ? (
        <text
          x="94"
          y="74"
          fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
          fontSize="8"
          fontWeight="600"
          letterSpacing="3.6"
          fill="#8E8E93"
        >
          ILLUMINATE YOUR CAREER
        </text>
      ) : null}
    </svg>
  );
}
