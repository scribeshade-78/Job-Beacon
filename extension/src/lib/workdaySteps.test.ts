// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasStep,
  isLoading,
  isVisible,
  navigationKind,
  readErrorBanner,
  waitForStepSettled,
  WORKDAY,
} from "./workdaySteps";

/**
 * THE STEP LOGIC, TESTED AGAINST THE PROVIDED DOM SKELETON.
 *
 * These fixtures are faithful to the structure we were given, and they are NOT proof that the
 * real Workday page carries these attributes - see the module header. What they pin is the
 * MACHINE: which control is irreversible, that an error aborts, and that a spinner is waited
 * out rather than filled through.
 *
 * jsdom reports every element as zero-sized, so getBoundingClientRect is stubbed to make an
 * element VISIBLE by default. The explicitly-hidden cases go through the hidden attribute, which
 * is a real code path and not a stubbed one.
 */

const STEP = `<div data-automation-id="workday-application-step"><input data-automation-id="legalNameSection_firstName"></div>`;
const LOADING = `<div data-automation-id="page-loading"><svg></svg></div>`;
const NEXT = `<button data-automation-id="bottom-navigation-next">Save and Continue</button>`;
const SUBMIT = `<button data-automation-id="bottom-navigation-submit">Submit Application</button>`;

beforeEach(() => {
  document.body.innerHTML = "";
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0,
  } as unknown as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isVisible", () => {
  it("treats a laid-out element as visible", () => {
    document.body.innerHTML = `<div id="x"></div>`;
    expect(isVisible(document.getElementById("x"))).toBe(true);
  });

  it("treats a missing element as not visible", () => {
    expect(isVisible(null)).toBe(false);
  });

  it("treats an explicitly hidden element as not visible", () => {
    document.body.innerHTML = `<div id="x" hidden></div>`;
    expect(isVisible(document.getElementById("x"))).toBe(false);
  });
});

describe("readErrorBanner", () => {
  it("returns null when Workday is showing no error", () => {
    document.body.innerHTML = STEP;
    expect(readErrorBanner(document)).toBeNull();
  });

  it("returns the validation message when a banner is visible", () => {
    document.body.innerHTML =
      STEP +
      `<div data-automation-id="errorBanner"><span data-automation-id="errorMessage">Please enter a valid phone number.</span></div>`;
    expect(readErrorBanner(document)).toBe("Please enter a valid phone number.");
  });

  it("IGNORES a hidden banner, which is present but not a failure", () => {
    // Workday keeps the banner in the DOM. Only a VISIBLE one means the step was rejected, and
    // treating a hidden one as an error would abort every step.
    document.body.innerHTML = STEP + `<div data-automation-id="errorBanner" hidden>stale</div>`;
    expect(readErrorBanner(document)).toBeNull();
  });

  it("says so rather than returning empty when the banner carries no text", () => {
    document.body.innerHTML = STEP + `<div data-automation-id="errorBanner"></div>`;
    expect(readErrorBanner(document)).toBe("Workday rejected this step without saying why.");
  });
});

describe("isLoading / hasStep", () => {
  it("reports the spinner between steps", () => {
    document.body.innerHTML = LOADING;
    expect(isLoading(document)).toBe(true);
  });

  it("is not loading once the spinner is gone", () => {
    document.body.innerHTML = STEP;
    expect(isLoading(document)).toBe(false);
    expect(hasStep(document)).toBe(true);
  });
});

describe("navigationKind - next is reversible, submit is not", () => {
  it("reads Save and Continue as next, by automation id", () => {
    document.body.innerHTML = NEXT;
    expect(navigationKind(document.querySelector("button")!)).toBe("next");
  });

  it("reads Submit Application as submit, by automation id", () => {
    document.body.innerHTML = SUBMIT;
    expect(navigationKind(document.querySelector("button")!)).toBe("submit");
  });

  it("falls back to the label when the button has no automation id", () => {
    document.body.innerHTML = `<button>Save and Continue</button><button>Submit Application</button>`;
    const [next, submit] = Array.from(document.querySelectorAll("button"));
    expect(navigationKind(next)).toBe("next");
    expect(navigationKind(submit)).toBe("submit");
  });

  it("does NOT guess: an unrecognised control is unknown, never submit", () => {
    // The dangerous default. Treating an unknown control as the final action would end an
    // application the candidate never finished reading.
    document.body.innerHTML = `<button>Back</button>`;
    expect(navigationKind(document.querySelector("button")!)).toBe("unknown");
  });

  it("accepts BOTH id sets we were given, because neither is a verified capture", () => {
    expect(WORKDAY.next).toContain("bottom-navigation-next");
    expect(WORKDAY.next).toContain("navigation-next");
    expect(WORKDAY.submit).toContain("bottom-navigation-submit");
    expect(WORKDAY.submit).toContain("navigation-submit");
    expect(WORKDAY.loading).toContain("page-loading-indicator");
    expect(WORKDAY.errorBanner).toContain("errorSummary");
    expect(WORKDAY.step).toContain("application-page");
  });

  it("reads the second capture's navigation ids", () => {
    document.body.innerHTML = '<button data-automation-id="navigation-next">Save and Continue</button>';
    expect(navigationKind(document.querySelector("button")!)).toBe("next");

    document.body.innerHTML = '<button data-automation-id="navigation-submit">Submit Application</button>';
    expect(navigationKind(document.querySelector("button")!)).toBe("submit");
  });

  it("treats Back as unknown, never as next - it moves the flow BACKWARDS", () => {
    document.body.innerHTML = '<button data-automation-id="navigation-back">Back</button>';
    expect(navigationKind(document.querySelector("button")!)).toBe("unknown");
  });

  it("reads the second capture's error summary and its message", () => {
    document.body.innerHTML =
      STEP +
      '<div data-automation-id="errorSummary" role="alert"><ul><li data-automation-id="error-message">1 Error: Please enter a valid phone number.</li></ul></div>';

    expect(readErrorBanner(document)).toBe("1 Error: Please enter a valid phone number.");
  });

  it("treats a display:none loading indicator as NOT loading", () => {
    // Workday keeps the indicator in the DOM permanently and toggles style.display, so "is the
    // spinner up" is really "is it displayed" - and the indicator being PRESENT means nothing.
    document.body.innerHTML =
      STEP + '<div data-automation-id="page-loading-indicator" style="display: none;"><svg></svg></div>';

    expect(isLoading(document)).toBe(false);
  });

  it("treats a displayed loading indicator as loading", () => {
    document.body.innerHTML = STEP + '<div data-automation-id="page-loading-indicator"><svg></svg></div>';
    expect(isLoading(document)).toBe(true);
  });

  it("recognises the second capture's page frame as a step", () => {
    document.body.innerHTML = '<div data-automation-id="application-page"></div>';
    expect(hasStep(document)).toBe(true);
  });
});

describe("waitForStepSettled", () => {
  const fast = { pollMs: 1, timeoutMs: 5_000 };

  it("returns ready once the spinner is gone and a step is rendered", async () => {
    document.body.innerHTML = STEP;
    await expect(waitForStepSettled(document, fast)).resolves.toEqual({ kind: "ready" });
  });

  it("returns ready after a spinner clears", async () => {
    document.body.innerHTML = STEP + LOADING;
    const settle = waitForStepSettled(document, fast);
    setTimeout(() => {
      document.querySelector(WORKDAY.loading)?.remove();
    }, 5);
    await expect(settle).resolves.toEqual({ kind: "ready" });
  });

  it("ABORTS on a validation banner, reporting what Workday said", async () => {
    document.body.innerHTML =
      STEP + `<div data-automation-id="errorBanner"><span data-automation-id="errorMessage">Please enter a valid phone number.</span></div>`;
    await expect(waitForStepSettled(document, fast)).resolves.toEqual({
      kind: "validation_error",
      message: "Please enter a valid phone number.",
    });
  });

  it("reports the error even while the spinner is still up", async () => {
    // The ordering that matters: checking loading first would wait out the whole timeout and
    // throw away the reason the step was rejected.
    document.body.innerHTML =
      LOADING +
      `<div data-automation-id="errorBanner"><span data-automation-id="errorMessage">Nope.</span></div>`;
    await expect(waitForStepSettled(document, { pollMs: 1, timeoutMs: 2_000 })).resolves.toEqual({
      kind: "validation_error",
      message: "Nope.",
    });
  });

  it("returns TIMEOUT - not ready and not failed - when a spinner never clears", async () => {
    // The honest unknown. The caller reports needs_verification; inventing success here is the
    // mistake this whole machine exists to avoid.
    document.body.innerHTML = STEP + LOADING;
    await expect(waitForStepSettled(document, { pollMs: 1, timeoutMs: 30 })).resolves.toEqual({
      kind: "timeout",
    });
  });

  it("does not report ready when the spinner is gone but no step rendered", async () => {
    document.body.innerHTML = `<div>nothing here</div>`;
    await expect(waitForStepSettled(document, { pollMs: 1, timeoutMs: 30 })).resolves.toEqual({
      kind: "timeout",
    });
  });
});
