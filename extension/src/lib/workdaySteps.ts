/**
 * Workday's multi-step application flow, extracted so it can be tested.
 *
 * WHY WORKDAY NEEDS ITS OWN STEP LOGIC. Greenhouse and Lever render one form and take one
 * submit. Workday is a Single Page Application that walks the candidate through several steps,
 * each one advanced by a "Save and Continue" button and each one able to reject the step with a
 * validation banner. A one-shot fill-and-submit engine therefore cannot drive it: it has no
 * concept of "not finished yet", so it either submits an incomplete application or reports an
 * outcome for a form it never completed. Workday is also the one site where the extension is the
 * sole executor - there is no server-side adapter behind it - so a wrong outcome here is
 * unrecoverable.
 *
 * THE SELECTORS ARE NAMED CONSTANTS ON PURPOSE, and they are now CAPTURED rather than inferred.
 * The values below were read off a real Workday tenant (nvidia.wd5.myworkdayjobs.com, the My
 * Information step) on 2026-10-17 and are pinned by
 * extension/src/lib/__fixtures__/workday-step.html. The two guessed attribute families that used
 * to be toleranced here matched NOTHING on that page, which is why the capture was worth doing.
 */

/**
 * The automation ids observed on the captured page, and the selectors built from them.
 *
 * THE OLD UNION WAS WRONG FOR EVERY CONTROL. It tolerated bottom-navigation-* / errorBanner /
 * page-loading and navigation-* / errorSummary / page-loading-indicator; the real page uses none
 * of them. Tolerating both was the honest answer while there was no evidence. There is evidence
 * now, so the guesses are gone and these ids are the only values this module acts on.
 *
 * TWO VALUES ARE STILL UNOBSERVED, and are labelled rather than guessed:
 *   loading  seen only transiently during a page transition; the settled step had no spinner
 *   submit   the Review step was never reached. pageFooterSubmitButton is INFERRED from
 *            pageFooterNextButton's naming, and navigationKind's label fallback covers it.
 */
const STEP_IDS = ["applyFlowPage", "applyFlowMyInfoPage"] as const;
const ERROR_BANNER_IDS = ["errorHeading"] as const;
const ERROR_MESSAGE_IDS = ["inputAlert"] as const;
const LOADING_IDS = ["loading"] as const;
const NEXT_IDS = ["pageFooterNextButton"] as const;
const SUBMIT_IDS = ["pageFooterSubmitButton"] as const;

/** querySelector accepts a selector list natively, so an array of ids costs no extra code. */
function selectorFor(ids: readonly string[]): string {
  return ids.map((id) => `[data-automation-id="${id}"]`).join(", ");
}

function matchesAnyId(automationId: string, ids: readonly string[]): boolean {
  return ids.some((id) => id.toLowerCase() === automationId);
}

export const WORKDAY = {
  step: selectorFor(STEP_IDS),
  errorBanner: selectorFor(ERROR_BANNER_IDS),
  errorMessage: selectorFor(ERROR_MESSAGE_IDS),
  loading: selectorFor(LOADING_IDS),
  next: selectorFor(NEXT_IDS),
  submit: selectorFor(SUBMIT_IDS),
} as const;

/** How long a step gets to finish loading before we stop waiting and say so. */
export const STEP_SETTLE_TIMEOUT_MS = 30_000;

/** The poll interval. Workday mutates the DOM rather than navigating. */
export const STEP_POLL_MS = 250;

/** Elements with no box are not visible; a hidden banner is not a validation failure. */
export function isVisible(element: Element | null): boolean {
  if (element === null) return false;
  if (element.hasAttribute("hidden")) return false;

  // AN EXPLICIT display:none TEST. Workday keeps its loading indicator in the DOM permanently
  // and toggles it with an inline style.display, so "is the spinner up" is really "is it
  // displayed". A zero-sized rect already answers that in a real browser, but relying on layout
  // alone makes the rule impossible to exercise where getBoundingClientRect is synthetic.
  const style = element.getAttribute("style") ?? "";
  if (/display\s*:\s*none/i.test(style)) return false;

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * The validation message Workday is currently showing, or null.
 *
 * READ BEFORE ANY FURTHER FILLING, because a step that failed validation keeps the candidate on
 * the same step with the same empty fields: carrying on would refill the same page, click
 * continue again, and either loop or submit something partial.
 */
export function readErrorBanner(doc: Document): string | null {
  const banner = doc.querySelector(WORKDAY.errorBanner);
  // The explicit null test is what NARROWS the type. isVisible accepts null, so relying on it
  // alone leaves banner as Element | null and the querySelector below fails to compile - which
  // is how this file shipped without a typecheck until the wiring change exposed it.
  if (banner === null || !isVisible(banner)) return null;
  const message = banner.querySelector(WORKDAY.errorMessage);
  const text = (message?.textContent ?? banner.textContent ?? "").trim();
  return text === "" ? "Workday rejected this step without saying why." : text;
}

/** Workday shows a spinner between steps. Filling during it targets the previous step's DOM. */
export function isLoading(doc: Document): boolean {
  return isVisible(doc.querySelector(WORKDAY.loading));
}

export function hasStep(doc: Document): boolean {
  return doc.querySelector(WORKDAY.step) !== null;
}

/**
 * Which navigation control this is.
 *
 * THE DISTINCTION IS THE IRREVERSIBLE ONE. "Save and Continue" only advances; the submit button
 * ends the application for real. The automation id is checked first because it is the site's own
 * declaration, and the label is the fallback for a button that has one and no id.
 */
export function navigationKind(button: Element): "next" | "submit" | "unknown" {
  const automationId = (button.getAttribute("data-automation-id") ?? "").toLowerCase().trim();

  // Derived from the SAME lists the selectors are built from, so a corrected id cannot be right
  // in one place and stale in the other.
  if (matchesAnyId(automationId, SUBMIT_IDS)) return "submit";
  if (matchesAnyId(automationId, NEXT_IDS)) return "next";

  // navigation-back lands here as "unknown", which is correct and load-bearing: it is a control
  // that moves the flow, but treating it as "next" would walk the candidate BACKWARDS through
  // their own application.

  const label = (button.textContent ?? button.getAttribute("aria-label") ?? "").trim();
  if (/^(submit|submit application|send application|send)$/i.test(label)) return "submit";
  if (/^(save and continue|next|continue)$/i.test(label)) return "next";

  return "unknown";
}

export type StepSettlement =
  | { kind: "ready" }
  | { kind: "validation_error"; message: string }
  | { kind: "timeout" };

export interface SettleDeps {
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  /**
   * The clock the deadline is measured against.
   *
   * INJECTABLE SO THE DEADLINE IS TESTABLE WITHOUT WAITING. sleep alone is not enough: the loop
   * reads Date.now() directly, so a test could shorten the timeout but still had to burn real
   * milliseconds to reach it — and could never assert HOW MANY polls the budget allowed. With
   * this injected, a test advances time by hand and pins both the boundary and the poll count.
   */
  now?: () => number;
}

/**
 * Waits for a step to finish settling, and reports which way it settled.
 *
 * THE THREE OUTCOMES ARE DELIBERATELY DIFFERENT. A validation error is terminal and must abort
 * the run so the attempt is reported rather than left filling a page that will never advance. A
 * timeout is NOT an error - it is an unknown, and the caller reports needs_verification rather
 * than inventing a success or a failure. Neither is allowed to look like "ready".
 *
 * POLLING RATHER THAN MutationObserver: the answer we need is not "did the DOM change" but "is
 * it settled now", and the spinner appearing and vanishing is itself two mutations. A poll that
 * asks the question directly is both simpler and immune to a missed observer callback.
 */
export async function waitForStepSettled(
  doc: Document,
  deps: SettleDeps = {},
): Promise<StepSettlement> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? STEP_SETTLE_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? STEP_POLL_MS;
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  while (now() - startedAt < timeoutMs) {
    await sleep(pollMs);

    // The error check comes FIRST. A step can show a banner while the spinner is still up, and
    // treating that moment as "loading" would wait out the timeout and lose the reason.
    const message = readErrorBanner(doc);
    if (message !== null) {
      return { kind: "validation_error", message };
    }

    if (!isLoading(doc) && hasStep(doc)) {
      return { kind: "ready" };
    }
  }

  return { kind: "timeout" };
}
