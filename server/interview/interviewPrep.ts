import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { MalformedInterviewPrepError, generateInterviewPrep, type RawInterviewPrep } from "./prepPrompt.js";

/**
 * Interview Preparation Phase 1 — the endpoint's application logic.
 *
 * Mirrors server/resumes/extractFacts.ts: one function returning a discriminated
 * result rather than throwing, so the route can map each outcome to a status
 * code without a try/catch per case, and so every failure is a value the tests
 * can assert on.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (Phase 1 scope, founder-confirmed):
 *   * No persistence. The generated prep is returned and forgotten — no table,
 *     no migration, no RLS. Nothing is stored, so nothing can leak.
 *   * No entitlement check. Protected by requireAuth + a per-candidate rate
 *     limit at the route, the same shape /api/resumes/:id/extract already uses.
 *
 * GROUNDING: only CONFIRMED facts reach the model. Raw extracted facts are
 * never read here — a candidate may not have reviewed them, and the project
 * invariant is that nothing presented as the candidate's qualification may be
 * unconfirmed. A candidate with no confirmed facts is NOT an error: the JD
 * alone still supports technical and behavioral questions (see prepPrompt.ts).
 */

export type InterviewPrepResult =
  | { kind: "success"; prep: RawInterviewPrep }
  | { kind: "vacancy_not_found" }
  | { kind: "no_jd_text" }
  | { kind: "malformed_prep"; message: string }
  | { kind: "error"; message: string };

type InterviewContext =
  | { kind: "ok"; roleTitle: string; jdText: string }
  | { kind: "vacancy_not_found" }
  | { kind: "no_jd_text" };

/**
 * Mirrors loadJobDescription's two queries (resumeGenerator.ts) but returns a
 * discriminated result instead of `{ title, jdText }`, because that shape
 * cannot express the difference this feature needs: a vacancy that does not
 * exist at all (404) versus one that exists but has no JD snapshot (422).
 * `raw_title` is NOT NULL, so a missing row is what produces the absent case.
 */
async function loadInterviewContext(
  client: Pick<SupabaseClient, "from">,
  vacancyId: string,
): Promise<InterviewContext> {
  const { data: vacancy, error: vacancyError } = await client
    .from("vacancies")
    .select("raw_title")
    .eq("id", vacancyId)
    .maybeSingle();

  if (vacancyError) {
    throw vacancyError;
  }

  if (!vacancy) {
    return { kind: "vacancy_not_found" };
  }

  const roleTitle = (vacancy as { raw_title: string }).raw_title;

  const { data: snapshot, error: snapshotError } = await client
    .from("vacancy_jd_snapshots")
    .select("clean_text")
    .eq("vacancy_id", vacancyId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (snapshotError) {
    throw snapshotError;
  }

  const jdText = (snapshot as { clean_text: string } | null)?.clean_text ?? "";

  // Whitespace-only JD text is treated as absent. Generating interview
  // questions from an empty description is exactly the fabrication this
  // feature must not do, and the route answers 422 rather than guessing.
  if (jdText.trim().length === 0) {
    return { kind: "no_jd_text" };
  }

  return { kind: "ok", roleTitle, jdText };
}

/**
 * The candidate's CONFIRMED facts, one "type: effective value" line each.
 *
 * Two-step query (facts, then the confirmations for those fact ids) — the same
 * shape generateResumePayload and evaluateVerifiedFacts use. `corrected_value`
 * wins over `extracted_facts.fact_value` when present, because a resume-grade
 * fact must reflect what the candidate actually confirmed rather than the raw
 * extraction. A fact whose confirmation row is missing is simply not confirmed,
 * so it never reaches the prompt.
 *
 * An empty array is a valid return, not a failure.
 */
async function loadConfirmedFactLines(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<string[]> {
  const { data: factRows, error: factError } = await client
    .from("extracted_facts")
    .select("id, fact_type, fact_value")
    .eq("candidate_id", candidateId);

  if (factError) {
    throw factError;
  }

  const facts = (factRows ?? []) as Array<{ id: string; fact_type: string; fact_value: string }>;

  if (facts.length === 0) {
    return [];
  }

  const { data: confirmationRows, error: confirmationError } = await client
    .from("fact_confirmations")
    .select("extracted_fact_id, corrected_value")
    .in(
      "extracted_fact_id",
      facts.map((fact) => fact.id),
    )
    .eq("status", "confirmed");

  if (confirmationError) {
    throw confirmationError;
  }

  const correctedValueByFactId = new Map(
    ((confirmationRows ?? []) as Array<{ extracted_fact_id: string; corrected_value: string | null }>).map((row) => [
      row.extracted_fact_id,
      row.corrected_value,
    ]),
  );

  return facts
    .filter((fact) => correctedValueByFactId.has(fact.id))
    .map((fact) => `${fact.fact_type}: ${correctedValueByFactId.get(fact.id) ?? fact.fact_value}`);
}

export async function prepareInterviewPrep(
  client: Pick<SupabaseClient, "from">,
  openaiClient: Pick<OpenAI, "chat">,
  params: { vacancyId: string; candidateId: string },
): Promise<InterviewPrepResult> {
  try {
    const context = await loadInterviewContext(client, params.vacancyId);

    if (context.kind === "vacancy_not_found") {
      return { kind: "vacancy_not_found" };
    }

    if (context.kind === "no_jd_text") {
      return { kind: "no_jd_text" };
    }

    const factLines = await loadConfirmedFactLines(client, params.candidateId);

    const prep = await generateInterviewPrep(openaiClient, {
      jdText: context.jdText,
      factLines,
      roleTitle: context.roleTitle,
    });

    return { kind: "success", prep };
  } catch (error) {
    if (error instanceof MalformedInterviewPrepError) {
      return { kind: "malformed_prep", message: error.message };
    }

    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
