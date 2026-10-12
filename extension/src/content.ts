/**
 * The field filler. Runs in the page, reads nothing, and sends nowhere.
 *
 * NO VALUE EVER LEAVES THIS SCRIPT. It receives a profile over chrome messaging,
 * types it into fields, and returns a report of what it did. There is no fetch here at
 * all, which is why the content script needs no host permission for jobbeacon.in - the
 * token and the network call both live in the service worker.
 *
 * IT FILLS AND STOPS. There is no submit anywhere in this file and there must not be:
 * auto-submitting an application on a candidate's behalf is the one action that cannot
 * be taken back, and a form filled by pattern-matching is exactly the kind of thing
 * that is confidently wrong. The candidate reviews and presses submit.
 *
 * DETECTION IS DELIBERATELY CONSERVATIVE, in this order:
 *   1. the autocomplete attribute, which is the ONLY signal a site sets on purpose
 *      for exactly this purpose (given-name, family-name, email, tel);
 *   2. the input type, which is a weaker but real statement of intent;
 *   3. name/id/label/placeholder text, which is a guess and therefore last.
 * A field already containing a value is NEVER overwritten. Overwriting is how an
 * auto-filler destroys an answer the candidate typed themselves.
 */
import type { CandidateProfile, FillReport } from "./lib/types.js";

interface FieldSpec {
  key: keyof CandidateProfile;
  label: string;
  /** Strongest signal: the site is telling us what this field is. */
  autocomplete: string[];
  /** Weaker: the element's own type. */
  types?: string[];
  /** Weakest: a guess from surrounding text. */
  patterns: RegExp[];
}

const FIELD_SPECS: FieldSpec[] = [
  {
    key: "firstName",
    label: "First name",
    autocomplete: ["given-name", "fname", "first-name"],
    types: [],
    // "first name" before the bare "name" fallback, and the negative-ish forms are
    // listed later so they cannot win by ordering.
    patterns: [/\bfirst[\s_-]?name\b/i, /\bgiven[\s_-]?name\b/i, /\bfname\b/i],
  },
  {
    key: "lastName",
    label: "Last name",
    autocomplete: ["family-name", "lname", "last-name"],
    types: [],
    patterns: [/\blast[\s_-]?name\b/i, /\bfamily[\s_-]?name\b/i, /\bsurname\b/i, /\blname\b/i],
  },
  {
    key: "email",
    label: "Email",
    autocomplete: ["email"],
    types: ["email"],
    patterns: [/\be[\s_-]?mail\b/i],
  },
  {
    key: "phone",
    label: "Phone",
    autocomplete: ["tel", "tel-national", "phone"],
    types: ["tel"],
    patterns: [/\bphone\b/i, /\bmobile\b/i, /\btelephone\b/i, /\btel\b/i],
  },
  {
    key: "linkedinUrl",
    label: "LinkedIn URL",
    autocomplete: ["url"],
    types: ["url"],
    // LinkedIn is named explicitly; a bare "url"/"website" is NOT matched, because
    // filling a portfolio field with a LinkedIn address is a wrong answer presented
    // confidently. Better to leave it and let the candidate fill it.
    patterns: [/linkedin/i],
  },
];

/** Fields this script must never touch, whatever the labels say. */
const FORBIDDEN_TYPES = new Set(["password", "hidden", "file", "submit", "button", "image", "reset", "checkbox", "radio"]);

function isFillable(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    return false;
  }
  if (element instanceof HTMLInputElement && FORBIDDEN_TYPES.has(element.type)) {
    return false;
  }
  if (element.disabled || element.readOnly) {
    return false;
  }
  // Not visible: a hidden duplicate of a field exists on many ATSs, and filling the
  // one the candidate cannot see is worse than not filling it at all.
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return false;
  }
  return true;
}

/** All the text a human would use to identify this field, lower-cased. */
function describingText(element: Element): string {
  const parts: string[] = [];
  const id = element.getAttribute("id");
  const name = element.getAttribute("name");
  const placeholder = element.getAttribute("placeholder");
  const aria = element.getAttribute("aria-label");
  if (id) parts.push(id);
  if (name) parts.push(name);
  if (placeholder) parts.push(placeholder);
  if (aria) parts.push(aria);

  if (id) {
    const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
    if (label?.textContent) parts.push(label.textContent);
  }
  const wrapping = element.closest("label");
  if (wrapping?.textContent) parts.push(wrapping.textContent);

  return parts.join(" ").toLowerCase();
}

/**
 * React (and every framework that tracks its own value) ignores a plain
 * `element.value = x`. Assigning through the PROTOTYPE'S setter updates the DOM value
 * without the framework's own tracker noticing, so the subsequent input event is what
 * actually tells React the value changed. Setting .value directly leaves the field
 * looking filled and submitting empty - the worst possible failure for this tool.
 */
function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }

  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function fillField(element: HTMLInputElement | HTMLTextAreaElement, spec: FieldSpec, value: string): "filled" | "occupied" {
  if (element.value.trim() !== "") {
    return "occupied";
  }
  setValue(element, value);
  element.setAttribute("data-jobbeacon-filled", spec.key);
  return "filled";
}

function fillForm(profile: CandidateProfile): FillReport {
  const report: FillReport = { filled: [], skipped: [] };
  const inputs = Array.from(document.querySelectorAll("input, textarea")).filter(isFillable);
  const claimed = new Set<Element>();

  for (const spec of FIELD_SPECS) {
    const value = (profile[spec.key] ?? "").trim();

    if (value === "") {
      report.skipped.push({ field: spec.label, reason: "Not in your JobBeacon profile." });
      continue;
    }

    // Strongest signal first, and a field already claimed by an earlier spec is out of
    // bounds - otherwise "First name" and "Last name" can both match one "Full name".
    const byAutocomplete = inputs.find((el) => {
      if (claimed.has(el)) return false;
      const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase().trim();
      return spec.autocomplete.includes(ac);
    });
    const byType = spec.types?.length
      ? inputs.find((el) => !claimed.has(el) && el instanceof HTMLInputElement && spec.types!.includes(el.type))
      : undefined;
    const byText = inputs.find((el) => {
      if (claimed.has(el)) return false;
      const text = describingText(el);
      return spec.patterns.some((pattern) => pattern.test(text));
    });

    const target = byAutocomplete ?? byType ?? byText;

    if (!target) {
      report.skipped.push({ field: spec.label, reason: "No matching field on this page." });
      continue;
    }

    claimed.add(target);
    const outcome = fillField(target as HTMLInputElement | HTMLTextAreaElement, spec, value);

    if (outcome === "occupied") {
      // Left alone ON PURPOSE, and reported rather than silently ignored.
      report.skipped.push({ field: spec.label, reason: "Already filled - left your answer alone." });
    } else {
      report.filled.push(spec.label);
    }
  }

  return report;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "FILL_FORM") {
    return false;
  }
  try {
    sendResponse({ ok: true, report: fillForm(message.profile as CandidateProfile) });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
});
