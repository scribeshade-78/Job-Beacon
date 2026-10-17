// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasStep, isLoading, navigationKind, readErrorBanner, WORKDAY } from "./workdaySteps";

/**
 * THE CONSTANTS, ASSERTED AGAINST A REAL WORKDAY PAGE.
 *
 * workdaySteps.test.ts proves the MACHINE with small fixtures. This file proves the CONSTANTS:
 * the markup below was captured from nvidia.wd5.myworkdayjobs.com on 2026-10-17 (My Information
 * step, signed in) and sanitised, so a selector that no longer matches reality fails here rather
 * than silently filling nothing in a candidate's browser.
 *
 * TWO VALUES ARE DELIBERATELY ABSENT FROM THE CAPTURE — loading and submit — and this file
 * asserts their absence instead of pretending to cover them. A test that quietly skipped them
 * would be the false assurance this fixture exists to replace.
 */

// Resolved from the repository root rather than import.meta.url: under the jsdom environment
// Vite rewrites import.meta.url to an http URL, and fileURLToPath rejects anything but file:.
const FIXTURE = readFileSync(
  resolve(process.cwd(), "extension/src/lib/__fixtures__/workday-step.html"),
  "utf8",
);

beforeEach(() => {
  document.body.innerHTML = FIXTURE;
  // jsdom reports every element as zero-sized; the module treats "no box" as not visible.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 120,
    height: 24,
    top: 0,
    left: 0,
    right: 120,
    bottom: 24,
    x: 0,
    y: 0,
  } as unknown as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WORKDAY constants against the captured page", () => {
  it("resolves every constant that the capture actually showed", () => {
    const observed = {
      step: WORKDAY.step,
      errorBanner: WORKDAY.errorBanner,
      errorMessage: WORKDAY.errorMessage,
      next: WORKDAY.next,
    };

    for (const [name, selector] of Object.entries(observed)) {
      expect(document.querySelector(selector), name + " matched nothing on the captured page").not.toBeNull();
    }
  });

  it("does NOT claim to cover loading or submit, which the capture never showed", () => {
    // Both are labelled unobserved in workdaySteps.ts. Pinning their absence keeps a later reader
    // from mistaking this fixture for evidence about them.
    expect(document.querySelector(WORKDAY.loading)).toBeNull();
    expect(document.querySelector(WORKDAY.submit)).toBeNull();
  });
});

describe("behaviour on the captured page", () => {
  it("recognises the page as a Workday step", () => {
    expect(hasStep(document)).toBe(true);
  });

  it("is not loading once the step has settled", () => {
    expect(isLoading(document)).toBe(false);
  });

  it("reads the validation panel Workday actually rendered", () => {
    const message = readErrorBanner(document);

    expect(message).not.toBeNull();
    expect(message).toContain("required");
  });

  it("classifies the footer button as next, by its captured automation id", () => {
    const next = document.querySelector('[data-automation-id="pageFooterNextButton"]');

    expect(next).not.toBeNull();
    expect(navigationKind(next!)).toBe("next");
  });

  it("finds nothing on an initial step that could be mistaken for submission", () => {
    // The irreversible action must not be reachable by inference. Nothing on this page is submit.
    for (const button of Array.from(document.querySelectorAll("button"))) {
      expect(navigationKind(button), button.textContent ?? "").not.toBe("submit");
    }
  });
});

describe("the fixture itself", () => {
  it("is a capture, not a synthetic page", () => {
    expect(FIXTURE).toContain("CAPTURED FROM A REAL WORKDAY PAGE");
    expect(FIXTURE).toContain("nvidia.wd5.myworkdayjobs.com");
  });

  it("carries no candidate email address", () => {
    expect(FIXTURE).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it("carries no script, handler or remote URL attribute", () => {
    expect(FIXTURE).not.toMatch(/<script/i);
    expect(FIXTURE).not.toMatch(/\son[a-z]+\s*=/i);
    expect(FIXTURE).not.toMatch(/\s(src|href|action)=/i);
  });
});
