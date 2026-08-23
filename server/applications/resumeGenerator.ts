import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * No real document-generation pipeline exists yet (no pdfkit or
 * equivalent is installed, no LLM template/prompt system exists) — these
 * are honest placeholder version tags, not a real template or model,
 * satisfying PRD §16.3's "record ... template version, model/prompt
 * version" requirement without pretending a generation step happened
 * that didn't. facts are echoed verbatim from confirmed data, never
 * paraphrased or embellished, so "never add unsupported skills,
 * employers, dates or metrics" holds trivially at this stage.
 */
const TEMPLATE_VERSION = "plain-json-v0";
const MODEL_VERSION = "verbatim-confirmed-facts-v0";

export class NoConfirmedFactsError extends Error {
  constructor(candidateId: string) {
    super(`No confirmed facts exist for candidate ${candidateId} — cannot generate a resume payload`);
    this.name = "NoConfirmedFactsError";
  }
}

/**
 * R7-M12: thrown by verifyFactuality when a fact in a payload doesn't trace
 * back to a confirmed extracted_facts row — formalizes an invariant
 * generateResumePayload's own query logic already guarantees on its normal
 * path, as an explicit, independently testable check rather than leaving it
 * implicit, so a future change to that logic can't silently violate PRD
 * §16.3's "never add unsupported ... data" requirement without a test
 * catching it.
 */
export class FactualityViolationError extends Error {
  constructor(public readonly extractedFactId: string) {
    super(
      `Fact ${extractedFactId} is not present in the candidate's confirmed facts — factuality check failed.`,
    );
    this.name = "FactualityViolationError";
  }
}

export interface ResumeFactEntry {
  extractedFactId: string;
  factType: string;
  factValue: string;
  /**
   * R7-M12 (PRD §16.3 "select evidence relevant to the vacancy"):
   * annotate-not-filter, per the locked design decision — every confirmed
   * fact always stays in the payload; this only marks whether it matched.
   * See isRelevantToVacancy's own doc comment for the matching semantics.
   */
  relevant: boolean;
}

export interface ResumePayload {
  candidateId: string;
  facts: ResumeFactEntry[];
  templateVersion: string;
  modelVersion: string;
  outputHash: string;
  generatedAt: string;
}

/**
 * PRD §16.3 ATS resume generation, minimal foundation: structures the
 * candidate's confirmed facts into a flat JSON payload — a proxy for a
 * generated document, since no real generation pipeline exists yet
 * (PRD §16.2's channel adapters are the same class of not-yet-built
 * dependency). Two-step query (facts, then confirmations for those fact
 * ids) mirrors evaluateVerifiedFacts's own shape.
 *
 * Throws NoConfirmedFactsError — not a generic Error — when the
 * candidate has zero confirmed facts, so a caller can distinguish "ask
 * the candidate to confirm facts first" from an actual database failure.
 *
 * R7-M12: vacancyTitle is an optional third parameter, not a query this
 * function makes itself — same "caller already fetched the row, pass the
 * field down" convention as eligibilityGate.ts's evaluateRoleMatch, so this
 * doesn't add a second vacancies query for data a caller already has.
 * Omitting it (or passing an empty/whitespace-only string) is a legitimate
 * call shape, not an error — every fact is simply annotated not-relevant,
 * since there is nothing to match against.
 */
export async function generateResumePayload(
  client: SupabaseClient,
  candidateId: string,
  vacancyTitle?: string,
): Promise<ResumePayload> {
  const { data: factRows, error: factError } = await client
    .from("extracted_facts")
    .select("id, fact_type, fact_value")
    .eq("candidate_id", candidateId);

  if (factError) {
    throw factError;
  }

  const facts = (factRows ?? []) as Array<{ id: string; fact_type: string; fact_value: string }>;

  if (facts.length === 0) {
    throw new NoConfirmedFactsError(candidateId);
  }

  const factIds = facts.map((fact) => fact.id);

  const { data: confirmationRows, error: confirmationError } = await client
    .from("fact_confirmations")
    .select("extracted_fact_id, corrected_value")
    .in("extracted_fact_id", factIds)
    .eq("status", "confirmed");

  if (confirmationError) {
    throw confirmationError;
  }

  // MP-F2: corrected_value is null when the candidate confirmed the
  // extracted value as-is, non-null when they edited it — a resume must
  // reflect what the candidate actually confirmed, not the raw extraction,
  // so corrected_value (when present) wins over extracted_facts.fact_value.
  const correctedValueByFactId = new Map(
    ((confirmationRows ?? []) as Array<{ extracted_fact_id: string; corrected_value: string | null }>).map((row) => [
      row.extracted_fact_id,
      row.corrected_value,
    ]),
  );
  const confirmedFactIds = new Set(correctedValueByFactId.keys());

  const confirmedFacts: ResumeFactEntry[] = facts
    .filter((fact) => confirmedFactIds.has(fact.id))
    .map((fact) => {
      const effectiveValue = correctedValueByFactId.get(fact.id) ?? fact.fact_value;
      return {
        extractedFactId: fact.id,
        factType: fact.fact_type,
        factValue: effectiveValue,
        relevant: isRelevantToVacancy(effectiveValue, vacancyTitle),
      };
    });

  if (confirmedFacts.length === 0) {
    throw new NoConfirmedFactsError(candidateId);
  }

  verifyFactuality(confirmedFacts, confirmedFactIds);

  const outputHash = createHash("sha256").update(JSON.stringify(confirmedFacts)).digest("hex");

  return {
    candidateId,
    facts: confirmedFacts,
    templateVersion: TEMPLATE_VERSION,
    modelVersion: MODEL_VERSION,
    outputHash,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * R7-M12 (PRD §16.3 "select evidence relevant to the vacancy"): deliberately
 * the same case-insensitive substring technique as eligibilityGate.ts's
 * evaluateRoleMatch — normalizedTitle.includes(normalizedValue) — reused
 * rather than a second matching convention invented for this file. Matches
 * against factValue only (the fact's actual content), not factType (a
 * category label like "years_of_experience"), since fact_type has no fixed,
 * PRD-defined taxonomy in this repository (same reasoning
 * extracted_facts.sql documents for not CHECK-constraining it) and matching
 * against an arbitrary label would be guessing, not an honest textual
 * signal. Both sides empty/blank return false — same "a blank value
 * matching every title" guard evaluateRoleMatch already documents — so a
 * missing vacancyTitle (or a fact with blank factValue) is reported as
 * not relevant, never as a false match.
 */
function isRelevantToVacancy(factValue: string, vacancyTitle: string | undefined): boolean {
  const normalizedTitle = (vacancyTitle ?? "").trim().toLowerCase();
  const normalizedValue = factValue.trim().toLowerCase();

  return normalizedTitle.length > 0 && normalizedValue.length > 0 && normalizedTitle.includes(normalizedValue);
}

/**
 * R7-M12 (PRD §16.3 "never add unsupported ... data"): an explicit,
 * independently unit-testable assertion of the invariant
 * generateResumePayload's own confirmedFactIds filter already guarantees on
 * its normal path — every fact in `facts` must trace back to a confirmed
 * extracted_facts row. Exported so a test can construct a payload that
 * deliberately violates the invariant directly, without needing to break
 * generateResumePayload's actual query logic to exercise the failure path.
 * Throws on the first violation found rather than collecting all of them:
 * one violation is already a factuality failure severe enough to reject the
 * whole payload, so there is no case where a caller needs the full list.
 */
export function verifyFactuality(facts: ResumeFactEntry[], confirmedFactIds: Set<string>): void {
  for (const fact of facts) {
    if (!confirmedFactIds.has(fact.extractedFactId)) {
      throw new FactualityViolationError(fact.extractedFactId);
    }
  }
}
