import { beforeEach, describe, expect, it } from "vitest";
import {
  isOverlayNode,
  mountOverlay,
  OVERLAY_HOST_ID,
  shouldMountOverlay,
  unmountOverlay,
} from "./overlay";
import { SITE_PROFILES } from "./sites";

const greenhouse = SITE_PROFILES.find((profile) => profile.sourceCode === "greenhouse");
if (greenhouse === undefined) {
  throw new Error("test setup: no greenhouse profile");
}

beforeEach(() => {
  unmountOverlay();
});

/**
 * THE MOUNT GATE. Both halves are load-bearing and neither is sufficient alone.
 * A known site opened normally is a candidate browsing; an unknown site carrying an
 * attempt id is the Tracker sending us somewhere we do not fill.
 */
describe("shouldMountOverlay", () => {
  it("mounts on a known site that the Tracker armed", () => {
    expect(shouldMountOverlay("https://boards.greenhouse.io/acme/jobs/1?jb_attempt_id=abc-123")).toBe(true);
  });

  it("does NOT mount on a known site opened normally", () => {
    // The common case: a candidate browsing a job board themselves. No fill, no prompt.
    expect(shouldMountOverlay("https://boards.greenhouse.io/acme/jobs/1")).toBe(false);
  });

  it("does NOT mount on an unknown site even when an attempt id is present", () => {
    // detectSite is the master gate, so the id alone never authorizes anything.
    expect(shouldMountOverlay("https://example.com/jobs/1?jb_attempt_id=abc-123")).toBe(false);
    expect(shouldMountOverlay("https://evilgreenhouse.io/jobs/1?jb_attempt_id=abc-123")).toBe(false);
  });

  it("does not mount when neither half is satisfied", () => {
    expect(shouldMountOverlay("https://example.com/jobs/1")).toBe(false);
  });

  it("does not mount on an unparseable URL rather than throwing", () => {
    expect(shouldMountOverlay("not a url")).toBe(false);
    expect(shouldMountOverlay("")).toBe(false);
  });
});

describe("the overlay host", () => {
  it("creates the host under the agreed id, with an OPEN shadow root", () => {
    mountOverlay(greenhouse);

    const host = document.getElementById(OVERLAY_HOST_ID);
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).not.toBeNull();
    expect(host?.shadowRoot?.mode).toBe("open");
  });

  it("is idempotent: mounting twice leaves exactly one host", () => {
    mountOverlay(greenhouse);
    mountOverlay(greenhouse);
    expect(document.querySelectorAll("#" + OVERLAY_HOST_ID).length).toBe(1);
  });

  it("removes the host on unmount", () => {
    mountOverlay(greenhouse);
    unmountOverlay();
    expect(document.getElementById(OVERLAY_HOST_ID)).toBeNull();
  });

  it("does not throw when unmounted before mounting, or twice in a row", () => {
    expect(() => unmountOverlay()).not.toThrow();
    mountOverlay(greenhouse);
    unmountOverlay();
    expect(() => unmountOverlay()).not.toThrow();
  });

  it("anchors the host against the page's own CSS with important inline styles", () => {
    // tsenta's overlay does this and the reasoning is sound: an ATS page can carry
    // `div { position: static !important }` and simply delete our anchor. Inline
    // important is the only declaration that outranks a page stylesheet.
    mountOverlay(greenhouse);
    const host = document.getElementById(OVERLAY_HOST_ID);
    expect(host?.style.getPropertyPriority("z-index")).toBe("important");
    expect(host?.style.getPropertyPriority("position")).toBe("important");
    expect(host?.style.getPropertyPriority("pointer-events")).toBe("important");
    // The host itself must never swallow a click meant for the form behind it.
    expect(host?.style.getPropertyValue("pointer-events")).toBe("none");
  });

  it("stays INVISIBLE to a document-level field query, which is why it is a shadow root", () => {
    // This is the isolation property the whole design rests on: fillForm() queries
    // document.querySelectorAll("input, textarea"), and none of the overlay's own
    // controls may ever appear in that list. A light-DOM overlay would put them there.
    mountOverlay(greenhouse);
    const shadow = document.getElementById(OVERLAY_HOST_ID)?.shadowRoot;
    const inner = document.createElement("button");
    inner.setAttribute("aria-label", "close");
    shadow?.appendChild(inner);

    expect(shadow?.querySelector("button")).not.toBeNull();
    expect(Array.from(document.querySelectorAll("button")).includes(inner)).toBe(false);
  });

  it("reports its own nodes to the self-exclusion guard", () => {
    mountOverlay(greenhouse);
    const host = document.getElementById(OVERLAY_HOST_ID) as HTMLElement;
    const inside = host.shadowRoot?.querySelector("[role='complementary']") as Element;
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    expect(isOverlayNode(host)).toBe(true);
    expect(isOverlayNode(inside)).toBe(true);
    expect(isOverlayNode(outside)).toBe(false);
    expect(isOverlayNode(null)).toBe(false);
    expect(isOverlayNode(undefined)).toBe(false);

    outside.remove();
  });

  it("announces itself without stealing focus", () => {
    mountOverlay(greenhouse);
    const region = document.getElementById(OVERLAY_HOST_ID)?.shadowRoot?.querySelector("[role='complementary']");
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-label")).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it("can be closed by the candidate", () => {
    const handle = mountOverlay(greenhouse);
    const close = document.getElementById(OVERLAY_HOST_ID)?.shadowRoot?.querySelector<HTMLButtonElement>("[data-jb-close]");
    expect(close).not.toBeNull();
    close?.click();
    expect(handle.isMounted()).toBe(false);
    expect(document.getElementById(OVERLAY_HOST_ID)).toBeNull();
  });

  it("puts the site's own name on the shell rather than a generic label", () => {
    mountOverlay(greenhouse);
    const shadow = document.getElementById(OVERLAY_HOST_ID)?.shadowRoot;
    expect(shadow?.textContent ?? "").toContain("Greenhouse");
  });

  it("declares the design tokens it borrows, and nothing else, inside the shadow root", () => {
    mountOverlay(greenhouse);
    const style = document.getElementById(OVERLAY_HOST_ID)?.shadowRoot?.querySelector("style");
    const css = style?.textContent ?? "";

    expect(css).toContain("--color-ios-card: #ffffff");
    expect(css).toContain("--color-ios-text-secondary: rgba(60, 60, 67, 0.78)");
    expect(css).toContain("--radius-card: 12px");
    // Every custom property the shell reads must be declared, or it silently falls back.
    for (const name of ["--color-ios-bg", "--color-ios-text", "--color-ios-separator", "--color-ios-blue", "--font-sans"]) {
      expect(css).toContain(name + ":");
    }
  });

  it("hard-codes NO colour or shadow outside the token rule", () => {
    // The clean-room line, enforced rather than remembered. Everything the shell paints with
    // must be a var() that resolves to a token the app already owns, so a vendor palette
    // cannot be dropped in without this failing. The :host block is where the token VALUES
    // legitimately live (and verify-build.mjs checks those against client/src/styles.css).
    mountOverlay(greenhouse);
    const css = document.getElementById(OVERLAY_HOST_ID)?.shadowRoot?.querySelector("style")?.textContent ?? "";

    const withoutTokenRule = css.replace(/:host \{ [^}]*\}/, "");
    expect(withoutTokenRule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(withoutTokenRule).not.toMatch(/\brgba?\(/);

    // And it really did resolve something, so this is not passing on an empty string.
    expect(withoutTokenRule).toContain("var(--color-ios-card)");
    expect(withoutTokenRule).toContain("var(--shadow-card)");
  });
});
