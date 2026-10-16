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
 * THE SELECTORS ARE NAMED CONSTANTS ON PURPOSE. The values below come from a PROVIDED DOM
 * SKELETON, not from a live Workday page, and Workday does not document them. Naming them in one
 * place is what makes re-verifying them against a real page a one-line correction instead of a
 * hunt through the filler. Nothing here claims to be verified against production.
 */

export const WORKDAY = {
  step: '[data-automation-id="workday-application-step"]',
  errorBanner: '[data-automation-id="errorBanner"]',
  errorMessage: '[data-automation-id="errorMessage"]',
  loading: '[data-automation-id="page-loading"]',
  next: '[data-automation-id="bottom-navigation-next"]',
  submit: '[data-automation-id="bottom-navigation-submit"]',
} as const;

/** How long a step gets to finish loading before we stop waiting and say so. */
export const STEP_SETTLE_TIMEOUT_MS = 30_000;

/** The poll interval. Workday mutates the DOM rather than navigating. */
export const STEP_POLL_MS = 250;

/** Elements with no box are not visible; a hidden banner is not a validation failure. */
export function isVisible(element: Element | null): boolean {
  if (element === null) return false;
  if (element.hasAttribute("hidden")) return false;
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
  if (!isVisible(banner)) return null;
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

  if (automationId === "bottom-navigation-submit") return "submit";
  if (automationId === "bottom-navigation-next") return "next";

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
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
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
