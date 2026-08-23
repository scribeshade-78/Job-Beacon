import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { extractResumeText, UnsupportedResumeFormatError } from "./textExtraction.js";
import {
  EXTRACTION_PROMPT_VERSION,
  DEFAULT_OPENAI_MODEL,
  MalformedExtractionError,
  runResumeFactExtraction,
  type RawEducationEntry,
  type RawExperienceEntry,
  type RawExtractionResult,
} from "./openaiExtraction.js";

export interface ExtractedFactRow {
  id: string;
  factType: string;
  factValue: string;
}

export type ExtractFactsResult =
  | { kind: "success"; facts: ExtractedFactRow[] }
  | { kind: "not_found" }
  | { kind: "unsupported_format" }
  | { kind: "malformed_extraction"; message: string }
  | { kind: "error"; message: string };

export interface ExtractFactsInput {
  resumeId: string;
  candidateId: string;
}

/**
 * Shared by education/experience: both are a 3-field (primary, secondary,
 * time-period) entry flattened into extracted_facts' single fact_value
 * column, since the table has no way to group multiple fields under one
 * logical entry across rows. Returns null (skip the row entirely) only
 * when every field is empty — the "never guess" rule applies to fields
 * within an entry too: present fields are kept as-is, absent ones are
 * simply omitted from the flattened string, never filled with a
 * placeholder like "Unknown".
 */
function flattenEntry(primary: string | null, secondary: string | null, tertiary: string | null): string | null {
  const head = [primary?.trim(), secondary?.trim()].filter((part): part is string => Boolean(part)).join(" — ");
  const tail = tertiary?.trim() || null;

  if (!head && !tail) {
    return null;
  }

  return head ? (tail ? `${head} (${tail})` : head) : tail;
}

function toFactRows(
  candidateId: string,
  sourceDocumentId: string,
  result: RawExtractionResult,
  model: string,
): Array<{
  candidate_id: string;
  source_document_id: string;
  fact_type: string;
  fact_value: string;
  extraction_model: string;
  extraction_prompt_version: string;
}> {
  const base = {
    candidate_id: candidateId,
    source_document_id: sourceDocumentId,
    extraction_model: model,
    extraction_prompt_version: EXTRACTION_PROMPT_VERSION,
  };

  const rows: ReturnType<typeof toFactRows> = [];

  const scalarFields: Array<[string, string | number | null]> = [
    ["full_name", result.full_name],
    ["email", result.email],
    ["phone", result.phone],
    ["location", result.location],
    ["current_title", result.current_title],
    ["years_of_experience", result.years_of_experience],
    ["most_recent_employer", result.most_recent_employer],
  ];

  for (const [factType, value] of scalarFields) {
    if (value === null) {
      continue;
    }
    const factValue = String(value).trim();
    if (factValue === "") {
      continue;
    }
    rows.push({ ...base, fact_type: factType, fact_value: factValue });
  }

  for (const skill of result.skills) {
    const factValue = skill.trim();
    if (factValue !== "") {
      rows.push({ ...base, fact_type: "skill", fact_value: factValue });
    }
  }

  for (const entry of result.education as RawEducationEntry[]) {
    const flattened = flattenEntry(entry.degree, entry.institution, entry.year);
    if (flattened) {
      rows.push({ ...base, fact_type: "education", fact_value: flattened });
    }
  }

  for (const entry of result.experience as RawExperienceEntry[]) {
    const flattened = flattenEntry(entry.title, entry.company, entry.duration);
    if (flattened) {
      rows.push({ ...base, fact_type: "experience", fact_value: flattened });
    }
  }

  return rows;
}

/**
 * Ownership is checked in application code, not RLS: every server route in
 * this repo uses the service-role client (requireModerator.ts's own
 * comment documents why — no request-scoped RLS client exists), which
 * bypasses RLS entirely. A missing resume and one that belongs to a
 * different candidate return the identical `not_found` result, so this
 * endpoint never confirms to a caller that a resume id exists but isn't
 * theirs.
 *
 * On any failure after the ownership check — download, text extraction,
 * OpenAI call, schema validation — zero rows are ever inserted: the full
 * set of fact rows is built in memory first and inserted in one batch
 * call, so a malformed-output rejection can never leave a partial write.
 */
export async function extractResumeFacts(
  serviceClient: SupabaseClient,
  openaiClient: Pick<OpenAI, "chat">,
  input: ExtractFactsInput,
  model: string = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
): Promise<ExtractFactsResult> {
  const { data: resumeRow, error: resumeError } = await serviceClient
    .from("resume_documents")
    .select("id, candidate_id, storage_path, mime_type")
    .eq("id", input.resumeId)
    .maybeSingle();

  if (resumeError) {
    return { kind: "error", message: "Could not look up this resume. Please try again." };
  }

  const resume = resumeRow as { id: string; candidate_id: string; storage_path: string; mime_type: string } | null;

  if (!resume || resume.candidate_id !== input.candidateId) {
    return { kind: "not_found" };
  }

  const { data: fileBlob, error: downloadError } = await serviceClient.storage
    .from("resumes")
    .download(resume.storage_path);

  if (downloadError || !fileBlob) {
    return { kind: "error", message: "Could not download this resume. Please try again." };
  }

  const buffer = Buffer.from(await fileBlob.arrayBuffer());

  let resumeText: string;

  try {
    resumeText = await extractResumeText(buffer, resume.mime_type);
  } catch (error) {
    if (error instanceof UnsupportedResumeFormatError) {
      return { kind: "unsupported_format" };
    }
    return { kind: "error", message: "Could not read this resume file. Please try again." };
  }

  let extraction: RawExtractionResult;

  try {
    extraction = await runResumeFactExtraction(openaiClient, resumeText, model);
  } catch (error) {
    if (error instanceof MalformedExtractionError) {
      return { kind: "malformed_extraction", message: "Could not validate the extracted facts. Please try again." };
    }
    return { kind: "error", message: "Could not extract facts from this resume right now. Please try again." };
  }

  const rows = toFactRows(input.candidateId, resume.id, extraction, model);

  if (rows.length === 0) {
    return { kind: "success", facts: [] };
  }

  const { data: insertedRows, error: insertError } = await serviceClient
    .from("extracted_facts")
    .insert(rows)
    .select("id, fact_type, fact_value");

  if (insertError || !insertedRows) {
    return { kind: "error", message: "Could not save the extracted facts. Please try again." };
  }

  const facts = (insertedRows as Array<{ id: string; fact_type: string; fact_value: string }>).map((row) => ({
    id: row.id,
    factType: row.fact_type,
    factValue: row.fact_value,
  }));

  // MP-F2: a candidate can only ever UPDATE fact_confirmations (no INSERT
  // grant — see that table's migration), so the pending row for each fact
  // has to be created here, service-role-side, at extraction time. Without
  // this, "Confirm"/"Correct"/"Reject" would silently match zero rows.
  const { error: confirmationInsertError } = await serviceClient
    .from("fact_confirmations")
    .insert(facts.map((fact) => ({ extracted_fact_id: fact.id, status: "pending" })));

  if (confirmationInsertError) {
    // Same "two separate writes, throw/report on the second one's failure"
    // precedent as reports.ts's submitVacancyReport: the extracted_facts
    // insert above already durably committed and is not rolled back. A
    // torn write here leaves real facts with no pending confirmation row
    // (out of scope to reconcile this phase), not a lost extraction.
    return { kind: "error", message: "Facts were extracted but could not be prepared for review. Please try again." };
  }

  return { kind: "success", facts };
}
