import { extractResumeText } from "../resumes/textExtraction.js";

/**
 * Task H3 — PRD v3 §16.3's "Run factuality, formatting and ATS quality checks."
 *
 * Factuality is already covered, and better, elsewhere: resumeGenerator.ts's
 * verifyFactuality + tailorsFromConfirmedFacts refuse any sentence that cannot be
 * traced to a fact the candidate confirmed, and the citation gate refuses
 * uncited claims. This module is the OTHER half of that sentence — formatting and
 * ATS quality — which nothing checked before, so a generated PDF that no
 * applicant tracking system could parse would have been submitted unchallenged.
 *
 * WHY THESE CHECKS AND NOT OTHERS. Each one corresponds to a way a resume
 * genuinely fails at an ATS, rather than to a stylistic preference:
 *
 *   - supported_format: many ATSes accept only PDF and DOCX. Everything else is
 *     rejected before a human ever sees it.
 *   - non_trivial_size: a few hundred bytes is not a document; it is a failed
 *     render that happened to upload.
 *   - text_extractable: THE BIG ONE. An image-only or scanned PDF renders
 *     perfectly and parses as nothing, so the ATS sees an empty resume. This is
 *     the single most common silent resume rejection and it is invisible to the
 *     candidate, which is exactly why it is checked rather than assumed.
 *   - sufficient_text: extraction can succeed and still yield almost nothing.
 *   - no_placeholder_tokens: template markers that survived rendering are worse
 *     than a missing field, because they are sent to the employer.
 *
 * WHAT IT IS NOT. Not a spell-checker, not a layout scorer, and not a judgement
 * about whether the content is good. Those are not checkable without inventing a
 * standard, and a check that fails for taste would train everyone to ignore it.
 */

export const ATS_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

/** Below this, the file is a failed render rather than a resume. */
export const MIN_DOCUMENT_BYTES = 1024;

/** A one-page resume is comfortably over this; below it, almost nothing parsed. */
export const MIN_EXTRACTED_CHARS = 200;

/** Template markers that must never reach an employer. */
const PLACEHOLDER_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "mustache", pattern: /\{\{[^}]{0,80}\}\}/ },
  { id: "erb", pattern: /<%[^>]{0,80}%>/ },
  { id: "todo", pattern: /\bTODO\b/i },
  { id: "placeholder", pattern: /\bPLACEHOLDER\b/i },
  { id: "lorem_ipsum", pattern: /lorem ipsum/i },
  { id: "insert_marker", pattern: /\[insert\b/i },
  { id: "your_name_here", pattern: /your name here/i },
];

export interface AtsCheckResult {
  id: string;
  passed: boolean;
  detail: string;
}

export interface AtsChecksOutcome {
  passed: boolean;
  checks: AtsCheckResult[];
  extractedTextChars: number;
}

export interface AtsCheckDeps {
  /** Injected in tests so the checks can be exercised without real PDF bytes. */
  extractText?: (bytes: Uint8Array, mimeType: string) => Promise<string>;
}

/**
 * Runs every check and returns all of them, not the first failure.
 *
 * Returning early would mean an operator fixing one problem and only then
 * discovering the next, and the stored result is meant to be a complete record
 * of what was verified about this file.
 */
export async function runAtsFormatChecks(
  bytes: Uint8Array,
  mimeType: string,
  deps: AtsCheckDeps = {},
): Promise<AtsChecksOutcome> {
  const extractText = deps.extractText ?? ((data: Uint8Array, type: string) => extractResumeText(Buffer.from(data), type));

  const checks: AtsCheckResult[] = [];

  const formatOk = (ATS_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
  checks.push({
    id: "supported_format",
    passed: formatOk,
    detail: formatOk ? mimeType : "Unsupported for ATS parsing: " + mimeType,
  });

  const sizeOk = bytes.byteLength >= MIN_DOCUMENT_BYTES;
  checks.push({
    id: "non_trivial_size",
    passed: sizeOk,
    detail: bytes.byteLength + " bytes (minimum " + MIN_DOCUMENT_BYTES + ")",
  });

  // Extraction is attempted only for a supported format; running it on anything
  // else would raise UnsupportedResumeFormatError and turn a clear "wrong
  // format" result into a crash.
  let text = "";
  let extractionError: string | null = null;

  if (formatOk) {
    try {
      text = await extractText(bytes, mimeType);
    } catch (error) {
      extractionError = error instanceof Error ? error.message : String(error);
    }
  }

  const extractedOk = formatOk && extractionError === null && text.trim().length > 0;
  checks.push({
    id: "text_extractable",
    passed: extractedOk,
    detail: !formatOk
      ? "skipped: unsupported format"
      : extractionError !== null
        ? "extraction failed: " + extractionError
        : extractedOk
          ? "extracted " + text.length + " characters"
          : "no text could be extracted — an image-only document parses as empty at an ATS",
  });

  const enoughText = extractedOk && text.trim().length >= MIN_EXTRACTED_CHARS;
  checks.push({
    id: "sufficient_text",
    passed: enoughText,
    detail: extractedOk
      ? text.trim().length + " characters (minimum " + MIN_EXTRACTED_CHARS + ")"
      : "skipped: no text extracted",
  });

  const foundPlaceholders = PLACEHOLDER_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.id);
  checks.push({
    id: "no_placeholder_tokens",
    passed: foundPlaceholders.length === 0,
    detail: foundPlaceholders.length === 0 ? "none found" : "found: " + foundPlaceholders.join(", "),
  });

  return {
    passed: checks.every((check) => check.passed),
    checks,
    extractedTextChars: text.trim().length,
  };
}
