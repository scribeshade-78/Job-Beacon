import { readAttemptId } from "./loop.js";
import { detectSite, type SiteProfile } from "./sites.js";
import { overlayTokenCss } from "./tokens.js";

/**
 * THE IN-PAGE SHELL: review without leaving the page.
 *
 * WHAT IT IS NOT. It is not an iframe of the ATS form and it is not a second copy of the
 * application. Tsenta frames the real board and strips x-frame-options and CSP from every
 * response to make that possible
 * (rules/strip-headers.json, condition with no urlFilter); this shell embeds nothing and
 * removes nothing. It is a small card that reports what JobBeacon did on the page the
 * candidate is already looking at.
 *
 * WHY A SHADOW ROOT, and this is the load-bearing decision. fillForm() identifies fields
 * with document.querySelectorAll("input, textarea"). A light-DOM overlay puts its own
 * buttons and any future input into that same list, where a pattern-matching filler can
 * reach them - the shell would become a candidate for its own autofill. A closed-off shadow
 * root makes that structurally impossible rather than merely guarded against, and
 * overlay.test.ts pins the isolation so a later "simplification" to a plain div fails.
 *
 * THE HOST IS ANCHORED WITH INLINE !important. An ATS page can carry
 * `div { position: static !important }` and delete our anchor; inline important is the one
 * declaration that outranks a page stylesheet. Tsenta does the same thing for the same
 * reason, and that part of the technique is worth taking.
 */
export const OVERLAY_HOST_ID = "jobbeacon-overlay-host";

export type OverlayTone = "idle" | "ok" | "error";

export interface OverlayHandle {
  isMounted(): boolean;
  setStatus(text: string, tone?: OverlayTone): void;
  destroy(): void;
}

let mounted: { host: HTMLElement; handle: OverlayHandle } | null = null;

/**
 * The self-exclusion guard.
 *
 * Events inside a shadow root are RETARGETED, so a click on the shell's close button reaches
 * a document-level listener with target === the host element. Everything the filler and the
 * click watcher do checks this first, so the shell can never be mistaken for page content.
 */
export function isOverlayNode(node: Element | null | undefined): boolean {
  if (!node || typeof node.closest !== "function") {
    return false;
  }

  if (node.closest("#" + OVERLAY_HOST_ID) !== null) {
    return true;
  }

  // closest() STOPS AT THE SHADOW BOUNDARY, which is the half of this that is easy to miss.
  // A node inside our own shadow root has no light-DOM ancestor called
  // #jobbeacon-overlay-host, so the check above returns null for exactly the nodes this
  // function exists to catch.
  //
  // Tsenta's guard is the closest() half alone, and that is sufficient only for events,
  // which are retargeted so target IS the host. It is not sufficient for a node reached any
  // other way - a querySelectorAll walk, a focusin target, a form element enumeration - and
  // a guard that is right for one caller and wrong for the next is worse than an obviously
  // incomplete one. This is caught by overlay.test.ts.
  const root = node.getRootNode();
  return root instanceof ShadowRoot && root.host.id === OVERLAY_HOST_ID;
}

/**
 * Whether the shell may appear on this page at all.
 *
 * BOTH HALVES ARE REQUIRED AND NEITHER IS SUFFICIENT. A known site opened normally is a
 * candidate browsing and must get nothing; an unknown site carrying an attempt id is the
 * Tracker pointing us somewhere we deliberately do not fill. detectSite is the master gate.
 *
 * PURE, so the whole mount rule is testable without a page, a browser or a network.
 */
export function shouldMountOverlay(url: string): boolean {
  return detectSite(url) !== undefined && readAttemptId(url) !== undefined;
}

function setImportant(element: HTMLElement, property: string, value: string): void {
  element.style.setProperty(property, value, "important");
}

/**
 * The shell's own stylesheet.
 *
 * NO COLOUR OR SHADOW LITERAL APPEARS OUTSIDE THE TOKEN RULE, and overlay.test.ts asserts
 * that by stripping the :host block and failing if a `#` or `rgb(` survives. Every visual
 * value is therefore a var() that resolves to a token the app already owns.
 */
const SHELL_CSS = [
  ":host { " + overlayTokenCss() + " }",
  ":host { position: fixed; }",
  ".jb-card {",
  "  pointer-events: auto;",
  "  box-sizing: border-box;",
  "  width: 300px;",
  "  max-width: calc(100vw - 32px);",
  "  padding: 12px;",
  "  border: 1px solid var(--color-ios-separator);",
  "  border-radius: var(--radius-card);",
  "  background: var(--color-ios-card);",
  "  color: var(--color-ios-text);",
  "  box-shadow: var(--shadow-card);",
  // Set explicitly rather than inherited: inheritable properties DO cross a shadow
  // boundary, so a page with a serif body font would otherwise restyle the shell.
  "  font-family: var(--font-sans);",
  "  font-size: 13px;",
  "  line-height: 1.45;",
  "  text-align: left;",
  "  letter-spacing: normal;",
  "  -webkit-font-smoothing: antialiased;",
  "}",
  ".jb-row { display: flex; align-items: center; gap: 8px; }",
  ".jb-mark {",
  "  display: flex; align-items: center; justify-content: center;",
  "  width: 26px; height: 26px; flex: 0 0 auto;",
  "  border-radius: var(--radius-control);",
  "  background: var(--color-ios-blue);",
  // --color-ios-card is #ffffff. Reusing the card token as the ink ON the accent keeps the
  // badge identical to the popup's without inventing an on-accent token the app does not own.
  "  color: var(--color-ios-card);",
  "  font-size: 11px; font-weight: 700;",
  "}",
  ".jb-titles { min-width: 0; flex: 1 1 auto; }",
  ".jb-title { margin: 0; font-size: 13px; font-weight: 600; }",
  ".jb-site { margin: 0; font-size: 11px; color: var(--color-ios-text-secondary); }",
  ".jb-close {",
  "  flex: 0 0 auto; width: 22px; height: 22px; padding: 0; cursor: pointer;",
  "  border: 1px solid var(--color-ios-separator);",
  "  border-radius: var(--radius-control);",
  "  background: var(--color-ios-card);",
  "  color: var(--color-ios-text-secondary);",
  "  font-family: var(--font-sans); font-size: 13px; line-height: 1;",
  "}",
  ".jb-close:focus-visible { outline: 2px solid var(--color-ios-blue); outline-offset: 2px; }",
  ".jb-status { margin: 10px 0 0; color: var(--color-ios-text-secondary); }",
  ".jb-foot { margin: 6px 0 0; font-size: 11px; color: var(--color-ios-text-secondary); }",
].join("\n");

export function mountOverlay(profile: SiteProfile): OverlayHandle {
  // IDEMPOTENT. The content script can reach this from more than one path, and a second
  // card stacked on the first is a visual bug with no upside.
  if (mounted !== null && mounted.host.isConnected) {
    return mounted.handle;
  }

  const host = document.createElement("div");
  host.id = OVERLAY_HOST_ID;
  setImportant(host, "position", "fixed");
  setImportant(host, "right", "16px");
  setImportant(host, "bottom", "16px");
  setImportant(host, "z-index", "2147483647");
  // The host is a transparent, click-through rectangle. Only the card inside it takes
  // pointer events, so the form behind the shell stays fully usable.
  setImportant(host, "pointer-events", "none");
  setImportant(host, "margin", "0");
  setImportant(host, "padding", "0");
  setImportant(host, "border", "0");
  setImportant(host, "background", "transparent");
  setImportant(host, "width", "auto");
  setImportant(host, "height", "auto");

  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = SHELL_CSS;

  const card = document.createElement("div");
  card.className = "jb-card";
  card.setAttribute("role", "complementary");
  card.setAttribute("aria-label", "JobBeacon application review");

  const row = document.createElement("div");
  row.className = "jb-row";

  const mark = document.createElement("span");
  mark.className = "jb-mark";
  mark.textContent = "JB";

  const titles = document.createElement("div");
  titles.className = "jb-titles";
  const title = document.createElement("p");
  title.className = "jb-title";
  title.textContent = "JobBeacon";
  const site = document.createElement("p");
  site.className = "jb-site";
  // The site's real display name, so the shell says where it is rather than a generic label.
  site.textContent = profile.displayName;
  titles.append(title, site);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "jb-close";
  close.setAttribute("data-jb-close", "");
  close.setAttribute("aria-label", "Hide JobBeacon");
  close.textContent = "\u00d7";

  row.append(mark, titles, close);

  const status = document.createElement("p");
  status.className = "jb-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Checking this application\u2026";

  const foot = document.createElement("p");
  foot.className = "jb-foot";
  foot.textContent = "Nothing is submitted for you. Review every answer, then apply.";

  card.append(row, status, foot);
  shadow.append(style, card);

  const handle: OverlayHandle = {
    isMounted: () => host.isConnected,
    setStatus: (text: string, tone: OverlayTone = "idle") => {
      status.textContent = text;
      status.style.color =
        tone === "ok"
          ? "var(--color-status-verified-fg)"
          : tone === "error"
            ? "var(--color-status-blocked-fg)"
            : "var(--color-ios-text-secondary)";
    },
    destroy: () => {
      host.remove();
      if (mounted?.host === host) {
        mounted = null;
      }
    },
  };

  close.addEventListener("click", () => handle.destroy());

  // documentElement is the fallback rather than an error: at document_idle the body exists,
  // but a shell that refuses to render because of a missing body would be a worse failure
  // than one anchored to the root.
  (document.body ?? document.documentElement).appendChild(host);

  mounted = { host, handle };
  return handle;
}

export function unmountOverlay(): void {
  if (mounted !== null) {
    mounted.host.remove();
    mounted = null;
  }
}
