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

export interface ResumeFactEntry {
  extractedFactId: string;
  factType: string;
  factValue: string;
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
 * dependency). Deliberately does NOT select facts by relevance to a
 * specific vacancy (PRD §16.3's "select evidence relevant to the
 * vacancy") — no vacancy-side fact-requirement taxonomy exists in this
 * repository, the same gap eligibilityGate.ts's verified_facts gate
 * already documents as a coarse presence check rather than a real
 * requirement match. Two-step query (facts, then confirmations for
 * those fact ids) mirrors evaluateVerifiedFacts's own shape.
 *
 * Throws NoConfirmedFactsError — not a generic Error — when the
 * candidate has zero confirmed facts, so a caller can distinguish "ask
 * the candidate to confirm facts first" from an actual database failure.
 */
export async function generateResumePayload(client: SupabaseClient, candidateId: string): Promise<ResumePayload> {
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
    .select("extracted_fact_id")
    .in("extracted_fact_id", factIds)
    .eq("status", "confirmed");

  if (confirmationError) {
    throw confirmationError;
  }

  const confirmedFactIds = new Set(
    ((confirmationRows ?? []) as Array<{ extracted_fact_id: string }>).map((row) => row.extracted_fact_id),
  );

  const confirmedFacts: ResumeFactEntry[] = facts
    .filter((fact) => confirmedFactIds.has(fact.id))
    .map((fact) => ({
      extractedFactId: fact.id,
      factType: fact.fact_type,
      factValue: fact.fact_value,
    }));

  if (confirmedFacts.length === 0) {
    throw new NoConfirmedFactsError(candidateId);
  }

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
