/**
 * Field identification, extracted from the filler so it can be tested.
 *
 * WHY THIS IS ITS OWN MODULE. content.ts is a content script: it runs on load, exports nothing,
 * and had no test file at all - while being the only code that fills a Workday application, the
 * one site where the extension is the sole executor and there is no server-side fallback. Pure
 * DOM-reading functions can be tested against a fixture; a content script cannot. Nothing here
 * touches module state, chrome APIs or the network.
 *
 * THE ORDER OF SIGNALS IS THE WHOLE POINT, and it is the same argument the filler's own header
 * makes about autocomplete: a token a site sets ON PURPOSE beats text we infer.
 *   1. autocomplete - the HTML standard for exactly this purpose.
 *   2. data-automation-id - Workday's own hook. Not a standard, but equally deliberate: it is
 *      the attribute Workday ships FOR automation, so it is a statement of intent rather than a
 *      guess, and it is stable where labels and layout are not.
 *   3. name/id/label/placeholder text - a guess, and therefore last.
 */

/** Workday's stable hook. Read as a deliberate signal, never as user-visible text. */
export const AUTOMATION_ID_ATTRIBUTE = "data-automation-id";

/** The field's own declared purpose, lower-cased. Empty when the site declares nothing. */
export function automationIdOf(element: Element): string {
  return (element.getAttribute(AUTOMATION_ID_ATTRIBUTE) ?? "").toLowerCase().trim();
}

/**
 * Every token a human would use to identify this field, lower-cased.
 *
 * THE AUTOMATION ID COMES FIRST, before any concatenated text. It is the one part of this
 * string that the site chose deliberately; putting it first means that when it does match, it
 * is unambiguous, and when it does not the weaker signals below still get their chance. This
 * matters most on Workday, where a step's container often wraps instructions, validation
 * messages and several fields, so element.closest("label") can concatenate a paragraph of
 * unrelated prose into the middle of the blob.
 */
export function describingText(element: Element): string {
  const parts: string[] = [];

  const automationId = automationIdOf(element);
  if (automationId) parts.push(automationId);

  const id = element.getAttribute("id");
  const name = element.getAttribute("name");
  const placeholder = element.getAttribute("placeholder");
  const aria = element.getAttribute("aria-label");
  if (id) parts.push(id);
  if (name) parts.push(name);
  if (placeholder) parts.push(placeholder);
  if (aria) parts.push(aria);

  if (id) {
    const label = element.ownerDocument.querySelector('label[for="' + CSS.escape(id) + '"]');
    if (label?.textContent) parts.push(label.textContent);
  }

  const wrapping = element.closest("label");
  if (wrapping?.textContent) parts.push(wrapping.textContent);

  return parts.join(" ").toLowerCase();
}
