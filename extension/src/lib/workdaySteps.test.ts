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

/**
 * THE SETTLE LOOP, DRIVEN BY A CLOCK THE TEST OWNS.
 *
 * NO REAL TIME ANYWHERE IN THIS BLOCK. sleep is a function that advances a counter, now reads it
 * back, and nothing ever waits — so the suite runs at the same speed on an idle laptop and a
 * loaded CI runner. That matters because the previous version reached its timeout by actually
 * sleeping 30ms, which proved the verdict but never the DEADLINE: how many polls the budget
 * allowed, or whether the loop could drift past it.
 *
 * The clock is also the only way to express "the spinner clears on the poll just before the
 * deadline", which is the boundary that decides whether the candidate sees "ready" or
 * "still loading".
 */
interface DrivenClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  elapsed: () => number;
  polls: () => number;
}

function drivenClock(onPoll?: (poll: number) => void): DrivenClock {
  let current = 0;
  let polls = 0;

  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
      polls += 1;
      onPoll?.(polls);
    },
    elapsed: () => current,
    polls: () => polls,
  };
}

function depsOf(clock: DrivenClock, timeoutMs: number, pollMs: number) {
  return { sleep: clock.sleep, now: clock.now, timeoutMs, pollMs };
}

describe("waitForStepSettled — ready paths", () => {
  it("returns ready on the FIRST poll when the step is already settled", async () => {
    document.body.innerHTML = STEP;
    const clock = drivenClock();

    await expect(waitForStepSettled(document, depsOf(clock, 1_000, 250))).resolves.toEqual({ kind: "ready" });

    expect(clock.polls()).toBe(1);
    expect(clock.elapsed()).toBe(250);
  });

  it("returns ready on the poll that clears the spinner", async () => {
    document.body.innerHTML = STEP + LOADING;
    const clock = drivenClock((poll) => {
      if (poll === 3) document.querySelector(WORKDAY.loading)?.remove();
    });

    await expect(waitForStepSettled(document, depsOf(clock, 1_000, 250))).resolves.toEqual({ kind: "ready" });

    // It waits exactly as long as the spinner is up, and not one poll longer.
    expect(clock.polls()).toBe(3);
    expect(clock.elapsed()).toBe(750);
  });

  it("does not report ready when the spinner is gone but no step rendered", async () => {
    document.body.innerHTML = `<div>nothing here</div>`;
    const clock = drivenClock();

    await expect(waitForStepSettled(document, depsOf(clock, 1_000, 250))).resolves.toEqual({ kind: "timeout" });

    expect(clock.polls()).toBe(4);
  });
});

describe("waitForStepSettled — the deadline", () => {
  it("returns TIMEOUT when the spinner never clears, having spent EXACTLY the budget", async () => {
    // The honest unknown. The caller reports needs_verification; inventing success here is the
    // mistake this whole machine exists to avoid.
    document.body.innerHTML = STEP + LOADING;
    const clock = drivenClock();

    await expect(waitForStepSettled(document, depsOf(clock, 1_000, 250))).resolves.toEqual({ kind: "timeout" });

    // 1000 / 250 = 4 polls, ending on the deadline rather than drifting past it.
    expect(clock.polls()).toBe(4);
    expect(clock.elapsed()).toBe(1_000);
  });

  it("OBSERVES the DOM at exactly the deadline, so a step that settles then is still ready", async () => {
    // The loop sleeps and THEN asks, and it only re-checks the budget at the top of the next
    // iteration. So the last permitted observation happens at elapsed === timeoutMs. That is a
    // deliberate boundary, not an accident: refusing a page that became ready on the final poll
    // would discard a step Workday had finished rendering.
    document.body.innerHTML = STEP + LOADING;
    const clock = drivenClock((poll) => {
      if (poll === 4) document.querySelector(WORKDAY.loading)?.remove();
    });

    await expect(waitForStepSettled(document, depsOf(clock, 1_000, 250))).resolves.toEqual({ kind: "ready" });
    expect(clock.elapsed()).toBe(1_000);
  });

  it("never polls again once the budget is spent, even if the spinner clears afterwards", async () => {
    document.body.innerHTML = STEP + LOADING;
    const clock = drivenClock((poll) => {
      if (poll === 5) document.querySelector(WORKDAY.loading)?.remove();
    });

    await expect(waitForStepSettled(document, depsOf(clock, 1_000, 250))).resolves.toEqual({ kind: "timeout" });

    // Poll 5 would have seen the cleared spinner, but the budget ended at poll 4.
    expect(clock.polls()).toBe(4);
  });

  it("overshoots the budget by AT MOST one poll interval", async () => {
    // The condition is checked BEFORE sleeping, so the final sleep can carry the clock past the
    // deadline. Bounded by pollMs, and asserted rather than assumed.
    document.body.innerHTML = STEP + LOADING;
    const clock = drivenClock();

    const timeoutMs = 1_000;
    const pollMs = 400;

    await expect(waitForStepSettled(document, depsOf(clock, timeoutMs, pollMs))).resolves.toEqual({ kind: "timeout" });

    expect(clock.polls()).toBe(3);
    expect(clock.elapsed()).toBe(1_200);
    expect(clock.elapsed()).toBeLessThanOrEqual(timeoutMs + pollMs);
  });

  it("returns immediately with no polls when the budget is zero", async () => {
    document.body.innerHTML = STEP;
    const clock = drivenClock();

    await expect(waitForStepSettled(document, depsOf(clock, 0, 250))).resolves.toEqual({ kind: "timeout" });

    expect(clock.polls()).toBe(0);
    expect(clock.elapsed()).toBe(0);
  });

  it("uses the module defaults when neither timeout nor poll interval is supplied", async () => {
    // Proves the real numbers without waiting for them: 30s at 250ms is 120 polls.
    document.body.innerHTML = STEP + LOADING;
    const clock = drivenClock();

    await expect(waitForStepSettled(document, { sleep: clock.sleep, now: clock.now })).resolves.toEqual({
      kind: "timeout",
    });

    expect(clock.elapsed()).toBe(30_000);
    expect(clock.polls()).toBe(120);
  });
});

describe("waitForStepSettled — validation beats loading and the deadline", () => {
  it("ABORTS on a validation banner, reporting what Workday said", async () => {
    document.body.innerHTML =
      STEP + `<div data-automation-id="errorBanner"><span data-automation-id="errorMessage">Please enter a valid phone number.</span></div>`;
    const clock = drivenClock();

    await expect(waitForStepSettled(document, depsOf(clock, 1_000, 250))).resolves.toEqual({
      kind: "validation_error",
      message: "Please enter a valid phone number.",
    });

    expect(clock.polls()).toBe(1);
  });

  it("reports the error even while the spinner is still up", async () => {
    // The ordering that matters: checking loading first would wait out the whole timeout and
    // throw away the reason the step was rejected.
    document.body.innerHTML =
      LOADING +
      `<div data-automation-id="errorBanner"><span data-automation-id="errorMessage">Nope.</span></div>`;
    const clock = drivenClock();

    await expect(waitForStepSettled(document, depsOf(clock, 2_000, 250))).resolves.toEqual({
      kind: "validation_error",
      message: "Nope.",
    });
  });

  it("lets a banner that appears on the LAST poll win over the timeout", async () => {
    document.body.innerHTML = STEP + LOADING;
    const clock = drivenClock((poll) => {
      if (poll === 4) {
        document.body.insertAdjacentHTML(
          "beforeend",
          `<div data-automation-id="errorBanner"><span data-automation-id="errorMessage">Too late, but true.</span></div>`,
        );
      }
    });

    await expect(waitForStepSettled(document, depsOf(clock, 1_000, 250))).resolves.toEqual({
      kind: "validation_error",
      message: "Too late, but true.",
    });
  });
});
