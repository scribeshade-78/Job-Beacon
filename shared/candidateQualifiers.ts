/**
 * Preferred qualifiers — what the candidate asked for BEYOND the canonical role.
 *
 * THE APPROVED CONTRACT (option b). Canonical selected-role relevance remains
 * REQUIRED; a raw phrase's extra words are PREFERENCES that rank otherwise
 * relevant jobs. "Azure Data Engineer" therefore boosts Data Engineer postings
 * that mention Azure, and a Data Engineer posting that does not mention Azure is
 * NOT excluded for that reason — it simply ranks below one that does.
 *
 * WHY NOT A HARD FILTER. Two independent reasons, either sufficient. The
 * qualifier is often not a catalog word at all ("azure"), so making it mandatory
 * would exclude jobs on a token this repository cannot vouch for; and because
 * eligibilityGate runs role_match at QUEUE time, a mandatory qualifier would
 * turn a stated preference into an automation REFUSAL. Neither is acceptable, so
 * nothing here can make anything ineligible.
 *
 * CATALOG MEMBERSHIP DOES NOT DECIDE MANDATORINESS. A qualifier stays a
 * preference whether or not it appears in the taxonomy; the taxonomy is a
 * curation layer for search, not a switch that hardens a preference into a
 * filter.
 *
 * EVIDENCE IS REQUIRED TO CLAIM A MATCH. A qualifier counts as matched only when
 * the posting's own title, description or structured skills contain it. Absence
 * of evidence is NOT a mismatch — it is unknown, and is reported as such rather
 * than as a failed requirement.
 *
 * PURE: no I/O, no clock, no imports. Same reasoning as shared/pipelineStages.ts
 * — the feed, discovery and eligibility must share one rule rather than each
 * re-deriving it.
 */

/** Words that carry no qualification and must never become a preference. */
const STOP_WORDS = new Set([
  "a", "an", "and", "the", "of", "for", "with", "in", "on", "at", "to", "or",
  "senior", "junior", "lead", "staff", "principal", "mid", "entry", "level",
]);

function tokensOf(value: string): string[] {
  return value
    .toLowerCase()
    // '.' is NOT preserved: it is allowed inside tokens like "node.js" but it
    // also ends sentences, so keeping it made "Snowflake." a token that never
    // matched "snowflake". Splitting it out costs a rare compound term and
    // avoids silently failing to see evidence that is plainly there.
    .split(/[^a-z0-9+#]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * The extra words the candidate asked for, excluding anything the canonical role
 * already says. Order is preserved and duplicates removed, so the label reads the
 * way the candidate wrote it.
 */
export function preferredQualifiers(
  rawRoleName: string | null | undefined,
  canonicalRoleName: string,
): string[] {
  if (typeof rawRoleName !== "string" || rawRoleName.trim() === "") {
    return [];
  }

  const canonical = new Set(tokensOf(canonicalRoleName));
  const seen = new Set<string>();
  const qualifiers: string[] = [];

  for (const token of tokensOf(rawRoleName)) {
    if (canonical.has(token) || seen.has(token)) {
      continue;
    }

    seen.add(token);
    qualifiers.push(token);
  }

  return qualifiers;
}

export interface QualifierEvidence {
  title: string;
  /** The captured JD text, when the source provided one. */
  description?: string | null;
  /** Structured skills, when the source or extraction provided them. */
  skills?: readonly string[];
}

export interface QualifierAssessment {
  /** Qualifiers the posting's own evidence supports. */
  matched: string[];
  /**
   * Qualifiers with NO supporting evidence. Deliberately named for what it is:
   * a posting that never mentions the word has not contradicted it, and must not
   * be presented as failing a requirement.
   */
  noEvidence: string[];
}

/** Whether the posting's own evidence supports one qualifier. */
export function qualifierHasEvidence(qualifier: string, evidence: QualifierEvidence): boolean {
  const haystack = tokensOf(
    [evidence.title, evidence.description ?? "", ...(evidence.skills ?? [])].join(" "),
  );

  return haystack.includes(qualifier);
}

export function assessQualifiers(
  qualifiers: readonly string[],
  evidence: QualifierEvidence,
): QualifierAssessment {
  const matched: string[] = [];
  const noEvidence: string[] = [];

  for (const qualifier of qualifiers) {
    if (qualifierHasEvidence(qualifier, evidence)) {
      matched.push(qualifier);
    } else {
      noEvidence.push(qualifier);
    }
  }

  return { matched, noEvidence };
}

/**
 * Orders two postings by qualifier preference. NEVER excludes: both are already
 * role-relevant by the caller's own requirement, so the worst outcome here is a
 * lower position. Stable on equal preference (returns 0) so a caller's existing
 * order (priority score) is preserved rather than scrambled.
 */
export function compareByQualifierPreference<T>(
  a: { evidence: QualifierEvidence },
  b: { evidence: QualifierEvidence },
  qualifiers: readonly string[],
): number {
  if (qualifiers.length === 0) {
    return 0;
  }

  const aMatched = assessQualifiers(qualifiers, a.evidence).matched.length;
  const bMatched = assessQualifiers(qualifiers, b.evidence).matched.length;

  return bMatched - aMatched;
}

/**
 * Candidate-facing label. "preferred", never "only": the contract is a ranking
 * preference, and copy that implied a filter would misdescribe what the system
 * does with the posting.
 */
export function qualifierPreferenceLabel(qualifiers: readonly string[]): string | null {
  if (qualifiers.length === 0) {
    return null;
  }

  const words = qualifiers.map((qualifier) => qualifier.charAt(0).toUpperCase() + qualifier.slice(1));

  return words.join(" ") + " preferred";
}
