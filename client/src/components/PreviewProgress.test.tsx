import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_STEPS, PreviewProgress, REASSURANCE_AFTER_MS } from "./PreviewProgress";
// The component's own source, so the colour rule is asserted against what ships.
import source from "./PreviewProgress.tsx?raw";

/**
 * The component's source WITHOUT its comments.
 *
 * These assertions are about the CLASSES it renders, and scanning prose as if it were markup
 * produced a real false positive: the reduced-motion check failed on this component's own comment
 * explaining that the pulse is guarded, because the comment quotes the unguarded token to name it.
 * Comments cannot render, so they are not evidence for or against a rendering rule.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const activeStep = () =>
  Number(screen.getByTestId("preview-progress").getAttribute("data-active-step"));

beforeEach(() => {
  vi.useFakeTimers();
});

// CLEANUP IS EXPLICIT BECAUSE THIS PROJECT DOES NOT SET vitest globals: true.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PreviewProgress", () => {
  it("names every phase up front, so the work ahead is visible from the first frame", () => {
    render(<PreviewProgress />);

    // SCOPED TO THE LIST. The first phase's label also appears in the visually-hidden live region,
    // so an unscoped getByText finds two elements and throws - which is how this was caught.
    const list = within(screen.getByTestId("preview-progress-steps"));
    for (const step of PREVIEW_STEPS) {
      expect(list.getByText(step.label)).toBeTruthy();
    }
  });

  it("starts on the first phase rather than on a blank or completed state", () => {
    render(<PreviewProgress />);
    expect(activeStep()).toBe(0);
  });

  it("advances with the clock, so a long wait visibly moves", () => {
    render(<PreviewProgress />);
    act(() => {
      vi.advanceTimersByTime(PREVIEW_STEPS[1].afterMs);
    });
    expect(activeStep()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(PREVIEW_STEPS[2].afterMs - PREVIEW_STEPS[1].afterMs);
    });
    expect(activeStep()).toBe(2);
  });

  it("HOLDS on the last phase and never claims to have finished", () => {
    // The request does not stream, so this component cannot know the work is done - the panel that
    // owns it does. A progress indicator that reaches its end and then keeps waiting is worse than
    // one that visibly holds, because the first one lies about being finished.
    render(<PreviewProgress />);
    act(() => {
      vi.advanceTimersByTime(600_000);
    });
    expect(activeStep()).toBe(PREVIEW_STEPS.length - 1);
  });

  it("reassures only once the wait is genuinely long", () => {
    render(<PreviewProgress />);
    expect(screen.queryByText(/still working/i)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(REASSURANCE_AFTER_MS + 1_000);
    });
    expect(screen.getByText(/still working/i)).toBeTruthy();
  });

  it("announces the running phase to assistive technology", () => {
    render(<PreviewProgress />);

    const live = screen.getByTestId("preview-progress-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("role")).toBe("status");
    expect(live.textContent).toBe(PREVIEW_STEPS[0].label);

    act(() => {
      vi.advanceTimersByTime(PREVIEW_STEPS[1].afterMs);
    });
    expect(live.textContent).toBe(PREVIEW_STEPS[1].label);
  });

  it("clears its interval on unmount, so a replaced panel cannot tick forever", () => {
    const { unmount } = render(<PreviewProgress />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hard-codes no colour: every colour is a token class", () => {
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\brgba?\(/);
    expect(code).not.toMatch(/style=\{\{/);
  });

  it("respects reduced motion instead of pulsing regardless", () => {
    expect(code).toContain("motion-safe:animate-pulse");

    // EVERY occurrence must sit behind the motion-safe: variant, so a candidate whose system asks
    // for reduced motion still gets the step list, just without the throb. Stripping the guarded
    // form and finding none left is stronger than a lookaround and needs no lookbehind support.
    const withoutGuarded = code.split("motion-safe:animate-pulse").join("");
    expect(withoutGuarded).not.toContain("animate-pulse");
  });
});
