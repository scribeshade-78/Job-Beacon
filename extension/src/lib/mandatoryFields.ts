/**
 * Mandatory-field detection and the fillable-element set, extracted so they can be tested.
 *
 * THESE REST ON STANDARDS, NOT ON WORKDAY'S DOM. That distinction is the point: a web search for
 * Workday's real attribute values returned nothing usable (the one relevant page is a
 * client-rendered shell with no selector content), so building on scraped Workday ids would have
 * been building on an unverified guess - the exact failure this project has already paid for
 * twice. Every signal below is ARIA/HTML, which is verifiable from the specifications:
 *
 *   - required / aria-required="true"  - the mandated-field contract
 *   - aria-haspopup="listbox", role="combobox" - the ARIA contract for a custom dropdown
 *
 * SO THE ANSWER TO "WILL WORKDAY'S DROPDOWN BE SEEN" IS YES, and it does not depend on knowing a
 * single Workday attribute: whatever Workday calls its classes, a custom listbox is one of these
 * roles by definition, or it is not accessible.
 */

/**
 * Everything the filler should look at.
 *
 * BUTTON-BASED DROPDOWNS ARE INCLUDED, and their absence was a real defect: a custom listbox is
 * a button with aria-haspopup="listbox" (or role="combobox"), not an input, so a query of
 * "input, textarea" cannot see it at all. Those fields are visible, mandatory and silently
 * skipped - and a field we cannot see is one we cannot even report as skipped.
 */
export const FILLABLE_SELECTOR =
  'input, textarea, button[aria-haspopup="listbox"], [role="combobox"]';

/** Input types that hold no text and must never be treated as fillable text fields. */
const NON_TEXT_INPUT_TYPES = new Set([
  "hidden", "submit", "button", "reset", "image", "file", "checkbox", "radio", "range", "color",
]);

/**
 * A button-based dropdown trigger. Distinguished from a text field because this engine writes
 * values through the prototype value setter, and a listbox has no text value to write - so these
 * are REPORTED and handed to the candidate, never typed into.
 */
export function isDropdownTrigger(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === "button") {
    return (element.getAttribute("aria-haspopup") ?? "").toLowerCase() === "listbox";
  }
  return (element.getAttribute("role") ?? "").toLowerCase() === "combobox";
}

/** A text field the filler may write into. */
export function isTextFillable(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag !== "input") return false;
  return !NON_TEXT_INPUT_TYPES.has((element.getAttribute("type") ?? "text").toLowerCase());
}

/** A field the filler may write into, or a dropdown trigger it may at least report. */
export function isFillableElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();

  if (tag === "textarea") {
    return true;
  }

  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }

  if (tag === "button") {
    return (element.getAttribute("aria-haspopup") ?? "").toLowerCase() === "listbox";
  }

  return (element.getAttribute("role") ?? "").toLowerCase() === "combobox";
}

/** Elements with no box are not visible; a hidden field is not one the candidate can see. */
export function isVisible(element: Element | null): boolean {
  if (element === null) return false;
  if (element.hasAttribute("hidden")) return false;
  if (element.closest('[aria-hidden="true"]') !== null) return false;

  const style = element.getAttribute("style") ?? "";
  if (/display\s*:\s*none/i.test(style)) return false;

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Whether the field declares itself mandatory. Attribute or property; either is the real thing. */
export function isMandatory(element: Element): boolean {
  if (element.hasAttribute("required")) return true;
  return (element.getAttribute("aria-required") ?? "").toLowerCase() === "true";
}

/**
 * The mandatory fields still empty AFTER a fill pass.
 *
 * ONLY INPUTS AND TEXTAREAS ARE JUDGED. Emptiness has a definition for them - value is blank -
 * and none for a button-based listbox, where "no selection" is rendered as prompt text we cannot
 * reliably distinguish from a chosen option without a verified capture. Reporting a filled
 * dropdown as empty would halt the run on a step that is actually complete, so this declines to
 * guess: a dropdown is NEVER reported here, and that limit is deliberate rather than an oversight.
 *
 * THIS IS THE SAFETY NET FOR THE WHOLE FILLER. Everything else may be best-effort; this is the
 * check that stops a step from being left half-answered while the candidate is told it is fine.
 */
export function findEmptyMandatoryFields(root: ParentNode): Element[] {
  const candidates = Array.from(root.querySelectorAll(FILLABLE_SELECTOR));

  return candidates.filter((element) => {
    if (!isVisible(element)) return false;
    if (!isMandatory(element)) return false;

    const tag = element.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return false;

    const value = (element as HTMLInputElement | HTMLTextAreaElement).value;
    return value.trim() === "";
  });
}
