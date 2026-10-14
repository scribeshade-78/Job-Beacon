/**
 * THE DESIGN TOKENS THE IN-PAGE OVERLAY BORROWS.
 *
 * These are JOBEACON'S OWN tokens. Tsenta's overlay injects its own palette through the
 * same technique, and copying that technique is right; copying its values would not be.
 * Every name and value below also exists in client/src/styles.css's @theme block, and
 * extension/verify-build.mjs FAILS THE BUILD if one of them stops matching it - so this
 * cannot quietly become a third, drifting definition of the product's colours.
 *
 * THE DRIFT IS REAL AND PRE-EXISTING. extension/src/popup/index.css already carries its own
 * copy of the same tokens with a comment acknowledging "the cost of the copy". A CSS file
 * cannot import a TypeScript constant, so the copy has to exist; what can change is whether
 * it is CHECKED. It is now, for both copies.
 *
 * THE *-fg STATUS VARIANTS ARE THE TEXT-SAFE ONES and that is not a stylistic preference.
 * client/src/styles.css documents that the literal status hues measure ~2.2:1 to ~3.55:1
 * against white and cannot carry text under WCAG 2.2 AA; the -fg variants were computed to
 * clear 4.5:1. An overlay is text on a light surface, so it takes the -fg pair.
 */
export const OVERLAY_TOKENS: Readonly<Record<string, string>> = {
  "--color-ios-blue": "#007aff",
  "--color-ios-blue-button": "#0066d6",
  "--color-ios-bg": "#f2f2f7",
  "--color-ios-card": "#ffffff",
  "--color-ios-separator": "#e5e5ea",
  "--color-ios-text": "#000000",
  "--color-ios-text-secondary": "rgba(60, 60, 67, 0.78)",

  "--color-status-verified-fg": "#1f7a37",
  "--color-status-blocked-fg": "#d6291f",

  "--radius-card": "12px",
  "--radius-control": "10px",

  "--shadow-card": "0 1px 2px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.06)",

  "--font-sans": '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
};

/**
 * The token declarations as a CSS declaration list, for one `:host` rule.
 *
 * Returned as declarations rather than a whole rule so the caller owns where they land.
 */
export function overlayTokenCss(): string {
  return Object.entries(OVERLAY_TOKENS)
    .map(([name, value]) => name + ": " + value + ";")
    .join(" ");
}
