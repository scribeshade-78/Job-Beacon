/**
 * THE ONE TOKENIZER for captured posting evidence (Batch D1-Q1, option d).
 *
 * WHY THIS EXISTS AS A SEPARATE MODULE. Query-time scoring must decide "does
 * this posting mention this qualifier" by TOKEN MEMBERSHIP, never by a second
 * text matcher. SQL cannot call this function, so the tokens are computed HERE,
 * once, and persisted; SQL only intersects sets. The moment a LIKE/regex
 * approximation appears at read time, "azure" starts matching "Azurea" and the
 * repository has two matchers that drift — the exact failure this module exists
 * to prevent.
 *
 * VERSIONED. TOKENIZER_VERSION travels with every persisted row, so a rule change
 * invalidates derived data explicitly instead of silently reinterpreting it. A
 * row whose version is not the current one is STALE, not wrong data to be
 * trusted: readers must treat it as not-yet-indexed for the current rule.
 *
 * The rules are deliberately the same ones shared/candidateQualifiers.ts applies
 * to a candidate's phrase, so a qualifier token and an evidence token are drawn
 * from one alphabet and can be compared by equality.
 */

/** Bump when tokenizeText's behaviour changes. Persisted alongside every row. */
export const TOKENIZER_VERSION = "evidence-tokens-v1";

/**
 * Lowercases, splits on anything that is not a letter, digit, '+' or '#', and
 * drops single characters.
 *
 * '.' is deliberately NOT preserved: it is allowed inside terms like "node.js"
 * but also ends sentences, and keeping it made the token "snowflake." — which
 * silently failed to match "snowflake" even though the evidence was plainly
 * there. Splitting it out costs a rare compound term and avoids an invisible
 * false negative.
 */
export function tokenizeText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

/** The evidence fields a posting can contribute, in the approved order. */
export interface CapturedEvidenceInput {
  /** vacancies.raw_title. */
  title: string;
  /** vacancy_jd_snapshots.clean_text for the chosen snapshot, or null when absent. */
  description?: string | null;
}

/**
 * The distinct tokens a posting's captured evidence contains.
 *
 * TITLE + CAPTURED DESCRIPTION ONLY. Model output (technical_fit_components),
 * candidate skills and generated summaries are NOT posting evidence and must
 * never be passed here — a qualifier match has to rest on what the employer's
 * posting actually said.
 */
export function evidenceTokens(input: CapturedEvidenceInput): string[] {
  const text = [input.title, input.description ?? ""].join(" ");

  return [...new Set(tokenizeText(text))].sort();
}

/**
 * A stable fingerprint of the evidence a token row was derived from, so an
 * indexer can tell whether a row is already current WITHOUT re-deriving tokens,
 * and can detect that captured evidence changed.
 *
 * It is a cheap non-cryptographic hash: this decides whether to redo derivation,
 * not whether to trust a security boundary.
 */
export function evidenceFingerprint(input: CapturedEvidenceInput): string {
  const text = input.title + "\u0000" + (input.description ?? "");
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16) + ":" + text.length.toString(16);
}

/** True when a persisted row was derived from this exact evidence and rule. */
export function isCurrentTokenRow(
  row: { tokenizerVersion: string | null; fingerprint: string | null },
  input: CapturedEvidenceInput,
): boolean {
  return row.tokenizerVersion === TOKENIZER_VERSION && row.fingerprint === evidenceFingerprint(input);
}
