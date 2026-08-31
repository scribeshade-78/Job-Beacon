import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import {
  analyzeTechnicalFit,
  FIT_ANALYSIS_PROMPT_VERSION,
  DEFAULT_FIT_MODEL,
} from "./fitPrompt.js";
import { extractJd, JD_EXTRACTOR_VERSION } from "./jdExtraction.js";
import {
  evaluatePracticalEligibility,
  type PracticalEligibilityInput,
} from "./practicalEligibility.js";
import type { ReasonEntry } from "./reasonCodes.js";

/**
 * Response Intelligence Phase 2.1 — orchestrates one (candidate, vacancy)
 * fit analysis: load confirmed facts + JD text, run the deterministic
 * Practical Eligibility rules engine and (when JD text exists) the AI
 * Technical Fit call, assemble the fit_analyses row. Pure of side effects
 * except one insert into vacancy_jd_snapshots when a snapshot for the
 * current vacancy_version does not exist yet.
 *
 * Throws only on genuine failure (DB error, malformed AI output) — the
 * worker turns a throw into a retry/backoff. An absent JD is NOT a throw:
 * the row is returned with jd_text_available = false and no Technical Fit.
 */

export interface AnalyzeFitDeps {
  openai: Pick<OpenAI, "chat">;
}

export interface FitAnalysisRow {
  candidate_id: string;
  vacancy_id: string;
  jd_snapshot_id: string | null;
  jd_text_available: boolean;
  technical_fit_score: number | null;
  technical_fit_components: Record<string, { score: number; rationale: string }> | null;
  missing_evidence: string[];
  practical_eligibility_score: number | null;
  hard_blockers: ReasonEntry[];
  soft_penalties: ReasonEntry[];
  eligibility_capped: boolean;
  top_reasons: string[];
  risks: string[];
  model_version: string;
  prompt_version: string;
}

interface VacancyRow {
  id: string;
  raw_title: string | null;
  source_code: string;
  country: string | null;
  region: string | null;
  city: string | null;
  remote_type: "remote" | "hybrid" | "on_site" | null;
}

interface ExtractedFactRow {
  id: string;
  fact_type: string;
  fact_value: string;
}

export class FitAnalysisTargetError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "FitAnalysisTargetError";
  }
}

async function loadConfirmedFacts(
  client: SupabaseClient,
  candidateId: string,
): Promise<Array<{ type: string; value: string }>> {
  const { data: factRows, error: factError } = await client
    .from("extracted_facts")
    .select("id, fact_type, fact_value")
    .eq("candidate_id", candidateId);

  if (factError) {
    throw factError;
  }

  const facts = (factRows ?? []) as ExtractedFactRow[];
  if (facts.length === 0) {
    return [];
  }

  const { data: confRows, error: confError } = await client
    .from("fact_confirmations")
    .select("extracted_fact_id, corrected_value")
    .in(
      "extracted_fact_id",
      facts.map((f) => f.id),
    )
    .eq("status", "confirmed");

  if (confError) {
    throw confError;
  }

  const corrected = new Map<string, string | null>(
    ((confRows ?? []) as Array<{ extracted_fact_id: string; corrected_value: string | null }>).map((r) => [
      r.extracted_fact_id,
      r.corrected_value,
    ]),
  );

  return facts
    .filter((f) => corrected.has(f.id))
    .map((f) => ({ type: f.fact_type, value: corrected.get(f.id) || f.fact_value }));
}

/**
 * Returns the JD snapshot for the vacancy's most recent raw version,
 * creating it (deterministic per-adapter extraction) if it does not exist.
 * `null` when the provider payload carries no usable JD text — no snapshot
 * row is written in that case.
 */
async function getOrCreateJdSnapshot(
  client: SupabaseClient,
  vacancy: VacancyRow,
): Promise<{ id: string; cleanText: string; sectionHeadings: string[] } | null> {
  const { data: versionRow, error: versionError } = await client
    .from("vacancy_versions")
    .select("id, raw_payload")
    .eq("vacancy_id", vacancy.id)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (versionError) {
    throw versionError;
  }
  if (!versionRow) {
    return null;
  }

  const version = versionRow as { id: string; raw_payload: unknown };

  const { data: existing, error: existingError } = await client
    .from("vacancy_jd_snapshots")
    .select("id, clean_text, sections")
    .eq("vacancy_version_id", version.id)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }
  if (existing) {
    const row = existing as { id: string; clean_text: string; sections: Array<{ heading: string | null }> };
    return {
      id: row.id,
      cleanText: row.clean_text,
      sectionHeadings: (row.sections ?? []).map((s) => s.heading).filter((h): h is string => !!h),
    };
  }

  const extraction = extractJd(vacancy.source_code, version.raw_payload);
  if (extraction.cleanText.trim() === "") {
    return null;
  }

  const { data: inserted, error: insertError } = await client
    .from("vacancy_jd_snapshots")
    .insert({
      vacancy_id: vacancy.id,
      vacancy_version_id: version.id,
      canonical_url: extraction.canonicalUrl ?? "",
      clean_text: extraction.cleanText,
      sections: extraction.sections,
      html_snapshot: extraction.htmlSnapshot,
      source_code: vacancy.source_code,
      extractor_version: JD_EXTRACTOR_VERSION,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw insertError ?? new Error("vacancy_jd_snapshots insert returned no row.");
  }

  return {
    id: (inserted as { id: string }).id,
    cleanText: extraction.cleanText,
    sectionHeadings: extraction.sections.map((s) => s.heading).filter((h): h is string => !!h),
  };
}

export async function analyzeFit(
  client: SupabaseClient,
  deps: AnalyzeFitDeps,
  target: { candidateId: string; vacancyId: string },
): Promise<FitAnalysisRow> {
  const { candidateId, vacancyId } = target;

  const { data: vacancyData, error: vacancyError } = await client
    .from("vacancies")
    .select("id, raw_title, source_code, country, region, city, remote_type")
    .eq("id", vacancyId)
    .maybeSingle();

  if (vacancyError) {
    throw vacancyError;
  }
  if (!vacancyData) {
    throw new FitAnalysisTargetError(`Vacancy ${vacancyId} not found.`);
  }
  const vacancy = vacancyData as VacancyRow;

  const facts = await loadConfirmedFacts(client, candidateId);
  const locationFact = facts.find((f) => f.type === "location")?.value ?? null;

  const eligInput: PracticalEligibilityInput = {
    candidateLocation: locationFact,
    vacancy: {
      country: vacancy.country,
      region: vacancy.region,
      city: vacancy.city,
      remoteType: vacancy.remote_type,
    },
  };
  const elig = evaluatePracticalEligibility(eligInput);

  // v1: hard_blockers is location-only, soft_penalties is always empty (its
  // codes are all reserved). Informational states (INSUFFICIENT_DATA when
  // practical_eligibility_score is null; LOCATION_UNKNOWN when a non-remote
  // vacancy has no country) are derivable by consumers and not persisted.
  const capped = elig.hardBlockers.length > 0;

  const snapshot = await getOrCreateJdSnapshot(client, vacancy);

  let technicalFitScore: number | null = null;
  let technicalFitComponents: FitAnalysisRow["technical_fit_components"] = null;
  let missingEvidence: string[] = [];
  let topReasons: string[] = [];
  let risks: string[] = [];

  if (snapshot) {
    const fit = await analyzeTechnicalFit(deps.openai, {
      jdText: snapshot.cleanText,
      sectionHeadings: snapshot.sectionHeadings,
      factLines: facts.map((f) => `${f.type}: ${f.value}`),
      roleTitle: vacancy.raw_title ?? "(unknown role)",
    });
    technicalFitScore = fit.overall;
    technicalFitComponents = fit.components;
    missingEvidence = fit.missing_evidence;
    topReasons = fit.top_reasons;
    risks = fit.risks;
  }

  return {
    candidate_id: candidateId,
    vacancy_id: vacancyId,
    jd_snapshot_id: snapshot?.id ?? null,
    jd_text_available: snapshot !== null,
    technical_fit_score: technicalFitScore,
    technical_fit_components: technicalFitComponents,
    missing_evidence: missingEvidence,
    practical_eligibility_score: capped ? 0 : elig.score,
    hard_blockers: elig.hardBlockers,
    soft_penalties: elig.softPenalties,
    eligibility_capped: capped,
    top_reasons: topReasons,
    risks,
    model_version: process.env.FIT_ANALYSIS_MODEL ?? process.env.OPENAI_MODEL ?? process.env.OPENROUTER_MODEL ?? DEFAULT_FIT_MODEL,
    prompt_version: FIT_ANALYSIS_PROMPT_VERSION,
  };
}
