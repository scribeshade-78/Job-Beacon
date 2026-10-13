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
import { classifySubmissionEvidence, readAttemptId, type EvidenceInput } from "./lib/loop.js";

/**
 * The resume the server has authorised for this fill, if any.
 *
 * SENT AS BASE64 OVER EXTENSION MESSAGING, NOT AS A URL. A content script running on
 * greenhouse.io fetching the resume from jobbeacon.in would be a cross-origin request
 * judged against GREENHOUSE's policy, and on an authenticated URL it would carry no
 * session. The bytes travel the same channel as the rest of the profile.
 */
interface ResumePayload {
  fileName: string;
  mimeType: string;
  base64: string;
}

interface FillRequest {
  profile: CandidateProfile;
  resume?: ResumePayload | null;
}

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

/**
 * A resume file input, if this page has one.
 *
 * FILE INPUTS ARE FOUND DIFFERENTLY, because none of the text heuristics apply: there is
 * no autocomplete token for "resume", and the value is not a string. The signals used are
 * the ones an ATS actually sets - the input's accept list, its id/name, and its label.
 *
 * DELIBERATELY NARROW. A page can carry several file inputs (cover letter, portfolio,
 * transcript, right-to-work document). Attaching a resume to the wrong one is worse than
 * attaching nothing, so this refuses unless the field says "resume"/"cv" in its own words.
 */
function findResumeInput(): HTMLInputElement | null {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));

  return (
    inputs.find((input) => {
      if (input.disabled) return false;
      if (input.files && input.files.length > 0) return false;

      const text = describingText(input);
      const accept = (input.getAttribute("accept") ?? "").toLowerCase();
      const looksLikeResume = /\b(resume|cv|curriculum)\b/.test(text);

      // A PDF/DOC accept list alone is NOT enough - a transcript or a portfolio also
      // takes PDFs. It only narrows a field that already called itself a resume.
      const plausibleFile = accept === "" || /pdf|msword|officedocument|doc/.test(accept);

      return looksLikeResume && plausibleFile;
    }) ?? null
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Attaches the resume to a file input.
 *
 * A FILE INPUT'S VALUE CANNOT BE ASSIGNED. Setting `input.value = "C:\\resume.pdf"` is
 * refused by the browser as a security measure, and it is a common trap: the code looks
 * correct and the field stays empty. The only supported route is a DataTransfer holding a
 * real File, which is what this builds.
 *
 * The file is CONSTRUCTED in this document, so it is same-origin and attachable. It is not
 * read from disk and not uploaded by this script - the form does that when the candidate
 * submits.
 */
function attachResume(input: HTMLInputElement, resume: ResumePayload): boolean {
  try {
    const file = new File([base64ToBytes(resume.base64)], resume.fileName, { type: resume.mimeType });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;

    // React and every other controlled-framework file field listens for this.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    input.setAttribute("data-jobbeacon-filled", "resume");
    return true;
  } catch {
    // A DataTransfer that the browser will not accept is a "could not attach", not a
    // crash that takes the rest of the fill down with it.
    return false;
  }
}

function fillField(element: HTMLInputElement | HTMLTextAreaElement, spec: FieldSpec, value: string): "filled" | "occupied" {
  if (element.value.trim() !== "") {
    return "occupied";
  }
  setValue(element, value);
  element.setAttribute("data-jobbeacon-filled", spec.key);
  return "filled";
}

function fillForm(request: FillRequest): FillReport {
  const { profile } = request;
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

  // THE RESUME IS FILLED LAST, deliberately. If attaching it throws, every text field is
  // already filled and the candidate keeps that work; the reverse order would risk losing
  // the whole fill to one unsupported file input.
  if (request.resume) {
    const input = findResumeInput();

    if (!input) {
      report.skipped.push({ field: "Resume", reason: "No resume upload field on this page." });
    } else if (attachResume(input, request.resume)) {
      report.filled.push("Resume");
    } else {
      report.skipped.push({ field: "Resume", reason: "The page refused the file - upload it manually." });
    }
  }

  return report;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "FILL_FORM") {
    return false;
  }
  try {
    sendResponse({
      ok: true,
      report: fillForm({ profile: message.profile as CandidateProfile, resume: (message.resume as ResumePayload | null) ?? null }),
    });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
});

/* ===========================================================================
 * THE LOOP. Added below the filler, and it never clicks anything.
 *
 * THE CANDIDATE PRESSES SUBMIT. This file's original invariant - there is no submit here and
 * there must not be - is intact: we WATCH for the click, we never make it. A form filled by
 * pattern-matching is exactly the kind of thing that is confidently wrong, so the one
 * irreversible action stays with the person who can see the form.
 *
 * WHAT WE DO INSTEAD: on load, if the Tracker armed this page, fill it and hold the lease.
 * Then listen, in the capture phase, for a click on a submit control. After the candidate
 * submits, wait for evidence to appear, and report what we SAW - never what we hoped.
 * ======================================================================== */

/** Held in memory only, for the lifetime of the page. Never written to storage. */
let armedAttemptId: string | null = null;
let armedLeaseToken: string | null = null;
let outcomeReported = false;

/**
 * Urls a portal redirects to when it has accepted an application. Conservative on purpose:
 * a false positive here reports a submission that did not happen, which is the one mistake
 * that leaves a candidate believing something was sent.
 */
const CONFIRMATION_URL = [/\/confirmation/i, /\/application\/requested/i, /\/applied/i, /\/thank[-_]?you/i];

/** Text a portal renders once it has accepted. */
const CONFIRMATION_TEXT = [
  /application (?:was |has been )?(?:submitted|received|sent)/i,
  /thank you for applying/i,
  /successfully applied/i,
];

/**
 * What the page shows, if anything. Reads only; it never clicks or navigates.
 *
 * BOUNDED TO VISIBLE TEXT of the document body, and no more: a portal's page can carry
 * unrelated marketing copy containing the word "submit", and matching that would report a
 * confirmation that never happened.
 */
function readConfirmationEvidence(): EvidenceInput {
  const href = location.href;
  const fromUrl = CONFIRMATION_URL.some((pattern) => pattern.test(href)) ? href : undefined;

  let fromText: string | undefined;
  const body = document.body;
  if (body) {
    const text = (body.innerText ?? "").slice(0, 20000);
    for (const pattern of CONFIRMATION_TEXT) {
      const match = text.match(pattern);
      if (match) {
        fromText = match[0];
        break;
      }
    }
  }

  return { confirmationUrl: fromUrl, confirmationText: fromText };
}

function isSubmitControl(element: Element): boolean {
  const tag = element.tagName.toLowerCase();

  if (tag === "input") {
    return (element as HTMLInputElement).type === "submit";
  }
  if (tag !== "button") {
    return false;
  }
  const button = element as HTMLButtonElement;
  if (button.type === "submit") {
    return true;
  }
  // NO SEPARATE CHECK FOR A MISSING type ATTRIBUTE: HTMLButtonElement.type already reports
  // "submit" for a bare button inside a form, which is the default portals rely on. An
  // earlier version tested button.type === "" after the return above, which TypeScript
  // correctly flagged as unreachable.
  const label = (button.innerText || button.getAttribute("aria-label") || "").trim();
  return /^(submit|apply|send application|send)$/i.test(label);
}

/**
 * Waits for the portal to say something, then reports it.
 *
 * IT DOES NOT ASSUME THE CLICK WORKED. It polls for a URL change or for confirmation text
 * for as long as the budget allows; if neither appears, the classifier returns
 * needs_verification and the Tracker shows "Action Required: Verify Submission". That is the
 * honest answer, and it is deliberately different from reporting success.
 */
async function watchForOutcome(deadlineMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const evidence = readConfirmationEvidence();
    if (evidence.confirmationUrl !== undefined || evidence.confirmationText !== undefined) {
      break;
    }
  }

  if (outcomeReported || armedAttemptId === null || armedLeaseToken === null) {
    return;
  }

  let classification;
  try {
    classification = classifySubmissionEvidence(readConfirmationEvidence());
  } catch (error) {
    classification = classifySubmissionEvidence({
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  }

  outcomeReported = true;

  await chrome.runtime.sendMessage({
    type: "REPORT_OUTCOME",
    payload: {
      attemptId: armedAttemptId,
      leaseToken: armedLeaseToken,
      outcome: classification.outcome,
      evidence: classification.evidence ?? null,
      error: classification.error ?? null,
    },
  });
}

/**
 * Trip 1, on load, and only when the Tracker armed this page.
 *
 * NO jb_attempt_id MEANS NOTHING HAPPENS. A candidate browsing a job board normally gets no
 * fill, no prompt and no network call - which is also why this cannot fill the wrong form.
 */
async function armFromUrl(): Promise<void> {
  const attemptId = readAttemptId(location.href);
  if (attemptId === undefined) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "PREPARE_FILL", attemptId });
    const payload = response?.payload as { allowed?: boolean; leaseToken?: string; fill?: { profile?: CandidateProfile } } | null;

    if (!response?.ok || !payload?.allowed || typeof payload.leaseToken !== "string") {
      // A refusal is not an error: the attempt may already be sent, or the plan may be
      // out of allowance. Nothing is filled, and the candidate is not interrupted.
      return;
    }

    armedAttemptId = attemptId;
    armedLeaseToken = payload.leaseToken;

    if (payload.fill?.profile) {
      fillForm({ profile: payload.fill.profile });
    }
  } catch {
    // The worker can be asleep, or the session expired. Either way, fill nothing.
  }
}

// CAPTURE PHASE, so the click is seen even when the portal stops propagation on its own
// handler - a very common pattern on application forms.
document.addEventListener(
  "click",
  (event) => {
    if (armedAttemptId === null || outcomeReported) {
      return;
    }
    const target = event.target as Element | null;
    if (target === null) {
      return;
    }
    // A click can land on a span inside the button.
    const control = target.closest("button, input[type=submit]") ?? target;
    if (!isSubmitControl(control)) {
      return;
    }
    void watchForOutcome(20000);
  },
  true,
);

/* ===========================================================================
 * THE APPROVAL HANDLER. The popup asks; this script performs.
 *
 * THE LEASE TOKEN NEVER LEAVES THIS CONTEXT. Trip 1 minted it here, and Trip 2 needs it, so
 * the popup asks the page to authorize rather than holding the credential itself. The popup
 * owns the UI and this owns the lease - one copy, in the context that already had it.
 *
 * THE ORDER IS THE DESIGN: approve, THEN authorize. The first writes review_approved_at on
 * the attempt; the second reads it. Reversed, a review_before_submit candidate would be
 * refused with NOT_APPROVED because the server had no record of an approval yet.
 * ======================================================================== */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "JB_APPROVE") {
    return false;
  }

  void (async () => {
    try {
      if (armedAttemptId === null || armedLeaseToken === null) {
        sendResponse({ ok: false, error: "This page is not armed for an application." });
        return;
      }

      // 1. The server records the approval. It reads the row, not our word for it.
      const approval = await chrome.runtime.sendMessage({ type: "APPROVE_ATTEMPT", attemptId: armedAttemptId });
      if (!approval?.ok) {
        sendResponse({ ok: false, error: approval?.error ?? "Could not record the approval." });
        return;
      }

      // 2. Only now is a submission token minted. Nothing has been sent yet - the candidate
      //    still presses submit on the page, and this script only watches for it.
      const authorized = await chrome.runtime.sendMessage({
        type: "AUTHORIZE_SUBMIT",
        attemptId: armedAttemptId,
        leaseToken: armedLeaseToken,
      });

      const result = authorized?.result as { allowed?: boolean; refusal?: string; reasonCode?: string } | null;
      sendResponse({ ok: true, allowed: result?.allowed === true, refusal: result?.refusal, reasonCode: result?.reasonCode });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();

  return true;
});
