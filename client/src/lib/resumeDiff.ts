/**
 * WORD-LEVEL DIFF FOR THE REVIEW SCREEN.
 *
 * PURE AND SYNCHRONOUS: two strings in, segments out. No DOM, no network, no model call, so
 * every rule below is testable without a browser or a session.
 *
 * WHY LCS RATHER THAN A SIMPLER COMPARISON. "Which words survived" is the question a
 * candidate actually asks of a tailored resume, and an LCS answers it in a way that stays
 * stable when text is inserted, deleted and rewritten at once. A line-by-line or
 * set-of-words comparison would report a reordered section as fully changed, which is the
 * kind of noise that makes a review screen useless.
 *
 * IT IS NOT AN ATS SCORE AND DOES NOT PRETEND TO BE. This says what the wording changed; it
 * says nothing about whether the result parses, which is a different question already
 * answered by the ATS checks recorded on the document.
 */

export type ResumeDiffKind = "same" | "added" | "removed";

export interface ResumeDiffSegment {
  kind: ResumeDiffKind;
  /** The original text of this run, spelling and whitespace intact. */
  text: string;
}

/**
 * The largest LCS table this will build, in cells.
 *
 * THE BOUND EXISTS BECAUSE THE INPUT IS USER CONTENT. The table is
 * (rows + 1) * (cols + 1) Int32s over the UNTRIVIAL middle of the pair, so a pathological
 * input - two long, wholly unrelated documents, which is exactly what defeats the shared-affix
 * trimming below - would otherwise allocate and fill a table big enough to stall the tab that
 * is rendering it.
 *
 * 4,000,000 cells is 16 MB. A realistic pair does not approach it: a 600-word resume is
 * roughly 1,200 tokens, and resumes share long identical runs, so the trimmed middle is
 * usually small. The caller is expected to treat a refusal as "show the document instead",
 * not as an error - see AttemptReview.
 */
export const RESUME_DIFF_CELL_LIMIT = 4_000_000;

/**
 * Thrown instead of silently degrading when the pair is too large to diff honestly.
 *
 * A fallback that reported the whole document as changed would be TRUE and useless, and one
 * that reported it as unchanged would be a lie. Refusing lets the caller render the PDF and
 * say nothing about wording, which is the only honest option left.
 */
export class ResumeDiffTooLargeError extends Error {
  constructor(
    public readonly cells: number,
    public readonly limit: number,
  ) {
    super(`Resume diff needs ${cells} table cells, above the ${limit} cell limit`);
    this.name = "ResumeDiffTooLargeError";
  }
}

/**
 * Split text into alternating runs of whitespace and non-whitespace.
 *
 * WHITESPACE IS TOKENISED, NOT DISCARDED. Diffing bare words and re-joining with single
 * spaces would render text that is not in the resume: line breaks between jobs and the
 * indentation inside bullets carry meaning, and a review screen that silently normalised them
 * would be showing the candidate something they are not approving.
 */
export function tokenizeResumeText(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

/**
 * The words that changed between the base resume and the tailored one.
 *
 * "added" is text present only in `tailored`; "removed" is text present only in `base`. The
 * segments, read in order, are the tailored resume with the removed runs shown inline.
 *
 * AT A REPLACEMENT, REMOVED IS EMITTED BEFORE ADDED, and the `>=` in the backtrack is what
 * makes that deterministic rather than incidental: both choices preserve the same LCS length,
 * so without a rule the output could flip between runs. Deletion first makes the pair read as
 * "was, then now", which is the order a reader expects.
 */
export function diffResumeWords(base: string, tailored: string): ResumeDiffSegment[] {
  const baseTokens = tokenizeResumeText(base);
  const tailoredTokens = tokenizeResumeText(tailored);
  const baseLength = baseTokens.length;
  const tailoredLength = tailoredTokens.length;

  // SHARED AFFIXES ARE TRIMMED FIRST, and this is free: removing a common prefix and a common
  // suffix cannot change the LCS. Resumes share long identical runs - a contact block, an
  // employer list, a degree - so this is what keeps a realistic pair far below the cell limit
  // even when the bodies differ completely.
  let prefix = 0;
  while (prefix < baseLength && prefix < tailoredLength && baseTokens[prefix] === tailoredTokens[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < baseLength - prefix &&
    suffix < tailoredLength - prefix &&
    baseTokens[baseLength - 1 - suffix] === tailoredTokens[tailoredLength - 1 - suffix]
  ) {
    suffix += 1;
  }

  const baseMiddle = baseTokens.slice(prefix, baseLength - suffix);
  const tailoredMiddle = tailoredTokens.slice(prefix, tailoredLength - suffix);
  const rows = baseMiddle.length;
  const cols = tailoredMiddle.length;

  const segments: ResumeDiffSegment[] = [];

  // ADJACENT RUNS OF THE SAME KIND ARE MERGED HERE, once, so a consumer can style a segment
  // without first having to work out whether the next one continues it. An empty run is never
  // pushed, so no segment has empty text.
  const push = (kind: ResumeDiffKind, text: string): void => {
    if (text.length === 0) {
      return;
    }
    const last = segments[segments.length - 1];
    if (last !== undefined && last.kind === kind) {
      last.text += text;
      return;
    }
    segments.push({ kind, text });
  };

  for (const token of baseTokens.slice(0, prefix)) {
    push("same", token);
  }

  if (rows > 0 || cols > 0) {
    const cells = (rows + 1) * (cols + 1);

    if (cells > RESUME_DIFF_CELL_LIMIT) {
      throw new ResumeDiffTooLargeError(cells, RESUME_DIFF_CELL_LIMIT);
    }

    const width = cols + 1;
    // dp[i * width + j] is the LCS length of baseMiddle[i..] against tailoredMiddle[j..],
    // filled BACKWARDS so every cell it reads is already computed.
    const dp = new Int32Array(cells);

    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = cols - 1; j >= 0; j -= 1) {
        dp[i * width + j] =
          baseMiddle[i] === tailoredMiddle[j]
            ? dp[(i + 1) * width + (j + 1)] + 1
            : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
      }
    }

    let i = 0;
    let j = 0;

    while (i < rows && j < cols) {
      if (baseMiddle[i] === tailoredMiddle[j]) {
        push("same", baseMiddle[i]);
        i += 1;
        j += 1;
        continue;
      }

      if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        push("removed", baseMiddle[i]);
        i += 1;
      } else {
        push("added", tailoredMiddle[j]);
        j += 1;
      }
    }

    // Whatever is left on either side never matched, so it is wholly added or wholly removed.
    while (i < rows) {
      push("removed", baseMiddle[i]);
      i += 1;
    }
    while (j < cols) {
      push("added", tailoredMiddle[j]);
      j += 1;
    }
  }

  // The suffix is read from base, but it is identical on both sides by construction.
  for (const token of baseTokens.slice(baseLength - suffix)) {
    push("same", token);
  }

  return segments;
}

export interface ResumeDiffSummary {
  addedWords: number;
  removedWords: number;
}

/**
 * Word counts for the headline, counted from the segments rather than from the raw strings.
 *
 * Counting words in the whole documents would count unchanged text as changed. Counting
 * SEGMENTS would report "Led a team of six engineers" as one word. Neither is what the reader
 * is being told, so this counts whitespace-separated words inside the changed runs only.
 */
export function summarizeResumeDiff(segments: readonly ResumeDiffSegment[]): ResumeDiffSummary {
  let addedWords = 0;
  let removedWords = 0;

  for (const segment of segments) {
    if (segment.kind === "same") {
      continue;
    }

    const trimmed = segment.text.trim();
    const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;

    if (segment.kind === "added") {
      addedWords += words;
    } else {
      removedWords += words;
    }
  }

  return { addedWords, removedWords };
}
