import type { SupabaseClient } from "@supabase/supabase-js";
import type { Browser } from "playwright";
import type OpenAI from "openai";
import { createOpenAIClient } from "../resumes/openaiClient.js";
import {
  loadBaseResumeDocument,
  loadResumeDocumentById,
  readResumeOptimizationLevel,
  tailorResumeForVacancy,
  TEMPLATE_VERSION,
  type BaseResumeDocument,
  type ResumeOptimizationLevel,
} from "./resumeGenerator.js";
import { storeTailoredResume, type RenderPdfDeps } from "./resumeDocument.js";
import type { SubmissionResume } from "./adapters/types.js";

/**
 * Mini-Phase 11 — "which file does this application submit?"
 *
 * The single answer to that question, asked once per attempt immediately before
 * the adapter is dispatched. Both callers that could otherwise answer it
 * differently — the adapter wanting a file to upload, and the audit trail
 * wanting to know which file went out — are served by the same call, so they
 * cannot disagree.
 *
 * Off never reaches the model, and never constructs an OpenAI client: the
 * client factory and the browser launcher are both dependencies that the 'off'
 * path returns before either is used. That matters beyond tidiness — a
 * candidate who has turned rewriting off must not have an application fail
 * because OPENROUTER_API_KEY is missing.
 */

export interface ResumeForSubmissionDeps extends RenderPdfDeps {
  /**
   * A factory rather than a client, so the OpenAI client is only constructed on
   * the paths that actually call a model. Injectable for tests.
   */
  createOpenAIClient?: () => Pick<OpenAI, "chat">;
}

export interface ResolveSubmissionResumeInput {
  applicationAttemptId: string;
  candidateId: string;
  vacancyId: string;
  /**
   * A preference the caller has already read. Omitted, it is read here.
   * Supplied, it is obeyed rather than re-read — two reads of a setting the
   * candidate can change between them is how a submission ends up obeying two
   * different preferences at once.
   */
  level?: ResumeOptimizationLevel;
}

/**
 * Resolves the resume for one attempt, generating and storing a tailored one
 * when the candidate's preference calls for it.
 *
 * When a tailored resume is produced, the attempt row records it immediately —
 * before the adapter is dispatched, not after it succeeds. If submission then
 * fails and the attempt is retried, the retry reuses the same row rather than
 * paying for a second generation, and the evidence for the failed attempt
 * already says which document it was trying to send. A tailored resume that is
 * never successfully submitted stays in the database as kind='tailored', where
 * it is invisible to the candidate's Resumes page and cannot be mistaken for
 * their own upload.
 */
async function resolveSubmissionResumeUnchecked(
  client: SupabaseClient,
  deps: ResumeForSubmissionDeps,
  input: ResolveSubmissionResumeInput,
): Promise<SubmissionResume> {
  const level: ResumeOptimizationLevel =
    input.level ?? (await readResumeOptimizationLevel(client, input.candidateId));

  // REUSE BEFORE REGENERATING. An attempt that already names a document has
  // had its resume prepared — by the approval route for a held attempt, or by
  // an earlier attempt at this same submission. Re-preparing would call the
  // model and render a second PDF for an application that already has its
  // file, and worse, would replace the very document the candidate reviewed
  // and approved with a different one generated afterwards. What the human
  // approved is what gets sent.
  const prepared = await loadPreparedDocument(client, input.applicationAttemptId);

  if (prepared) {
    return {
      documentId: prepared.documentId,
      storagePath: prepared.storagePath,
      originalFilename: prepared.originalFilename,
      mimeType: prepared.mimeType,
      // Taken from the document, not from the preference read above: the file
      // may have been produced under a setting the candidate has since
      // changed, and the evidence has to describe the file that was sent.
      tailored: prepared.optimizationLevel !== null,
      optimizationLevel: prepared.optimizationLevel ?? "off",
    };
  }

  if (level === "off") {
    // The base resume, read directly. No OpenAI client is constructed and no
    // browser is launched on this path — which is why neither is a hard
    // dependency of this module: a candidate who turned rewriting off must not
    // have an application fail because OPENROUTER_API_KEY is unset.
    const baseResume = await loadBaseResumeDocument(client, input.candidateId);

    return {
      documentId: baseResume.documentId,
      storagePath: baseResume.storagePath,
      originalFilename: baseResume.originalFilename,
      mimeType: baseResume.mimeType,
      tailored: false,
      optimizationLevel: "off",
    };
  }

  const openai = (deps.createOpenAIClient ?? createOpenAIClient)();

  // The level is passed down rather than re-read: the candidate could change
  // the setting between two reads, and a submission that starts as "honest" and
  // silently becomes "off" halfway through is exactly the kind of drift the
  // setting exists to prevent.
  const result = await tailorResumeForVacancy(client, { openai }, {
    candidateId: input.candidateId,
    vacancyId: input.vacancyId,
    level,
  });

  if (result.kind !== "generated") {
    throw new Error(`resolveSubmissionResume: tailoring was bypassed for level "${level}"`);
  }

  const { data: vacancy, error: vacancyError } = await client
    .from("vacancies")
    .select("raw_title")
    .eq("id", input.vacancyId)
    .maybeSingle();

  if (vacancyError) {
    throw vacancyError;
  }

  const vacancyTitle = (vacancy as { raw_title: string } | null)?.raw_title ?? "";

  const payload = result.content;
  const document = await storeTailoredResume(
    client,
    deps,
    {
      candidateId: input.candidateId,
      vacancyId: input.vacancyId,
      vacancyTitle,
      content: payload,
      // The contact header needs the confirmed facts, which the tailoring step
      // already read. Re-reading them here would be a second source of truth
      // for the same values.
      facts: await loadFactsForHeader(client, input.candidateId),
      // result.level is narrowed to the two rewriting levels by the
      // "generated" check above, which is exactly what the store expects.
      optimizationLevel: result.level,
      // Task H3, PRD §16.3: the generator already computed these and this call
      // site previously dropped them, so the row recorded the file and nothing
      // about how it was produced. Carried through so a later reader can answer
      // "which facts, which template, which model" without re-generating.
      templateVersion: TEMPLATE_VERSION,
      modelVersion: result.modelVersion,
      // factsSha256 is deliberately NOT passed on this path. The tailoring result
      // carries modelVersion and promptVersion but no digest of the confirmed
      // facts it used, and computing one here from a second read of the facts
      // would be a different value from the one the generator worked from. NULL
      // is the honest record for "not available on this path"; the document's own
      // output_sha256 is still computed over the bytes, which is what actually
      // ties the submitted file to the generated one.
    },
  );

  const { error: updateError } = await client
    .from("application_attempts")
    .update({ resume_document_id: document.documentId, updated_at: new Date().toISOString() })
    .eq("id", input.applicationAttemptId);

  if (updateError) {
    throw updateError;
  }

  return {
    documentId: document.documentId,
    storagePath: document.storagePath,
    originalFilename: document.originalFilename,
    mimeType: document.mimeType,
    tailored: true,
    optimizationLevel: level,
  };
}

/**
 * The confirmed facts, for the resume header only. Deliberately re-read rather
 * than threaded through the tailoring result: the result carries the tailored
 * claims, not the source facts, and widening that return type so a renderer can
 * read the candidate's email out of it would make the tailoring result a
 * general-purpose candidate record.
 */
async function loadFactsForHeader(
  client: SupabaseClient,
  candidateId: string,
): Promise<import("./resumeGenerator.js").ResumeFactEntry[]> {
  const { data, error } = await client
    .from("extracted_facts")
    .select("id, fact_type, fact_value")
    .eq("candidate_id", candidateId);

  if (error) {
    throw error;
  }

  const facts = (data ?? []) as Array<{ id: string; fact_type: string; fact_value: string }>;

  if (facts.length === 0) {
    return [];
  }

  const { data: confirmationRows, error: confirmationError } = await client
    .from("fact_confirmations")
    .select("extracted_fact_id, corrected_value")
    .in("extracted_fact_id", facts.map((fact) => fact.id))
    .eq("status", "confirmed");

  if (confirmationError) {
    throw confirmationError;
  }

  const correctedByFactId = new Map(
    ((confirmationRows ?? []) as Array<{ extracted_fact_id: string; corrected_value: string | null }>).map((row) => [
      row.extracted_fact_id,
      row.corrected_value,
    ]),
  );

  return facts
    .filter((fact) => correctedByFactId.has(fact.id))
    .map((fact) => ({
      extractedFactId: fact.id,
      factType: fact.fact_type,
      factValue: correctedByFactId.get(fact.id) ?? fact.fact_value,
      relevant: false,
    }));
}

/**
 * The document this attempt is already set to submit, if any. One query: the
 * attempt row is the authoritative link, and a NULL link is the normal state
 * for an attempt that has not been prepared yet.
 */
async function loadPreparedDocument(
  client: SupabaseClient,
  applicationAttemptId: string,
): Promise<BaseResumeDocument | null> {
  const { data, error } = await client
    .from("application_attempts")
    .select("resume_document_id")
    .eq("id", applicationAttemptId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const documentId = (data as { resume_document_id: string | null } | null)?.resume_document_id;

  if (!documentId) {
    return null;
  }

  return loadResumeDocumentById(client, documentId);
}

/**
 * Task H3, PRD §16.3: a document whose stored ATS quality checks FAILED must not
 * be submitted.
 *
 * This is the enforcement half of atsChecks.ts. Running the checks and recording
 * the result changes nothing on its own; without this, a generated PDF that no
 * ATS can parse would be uploaded to an employer and the candidate's application
 * would silently count as sent.
 *
 * NULL CHECKS ARE ALLOWED, and that is the deliberate half of the rule. A
 * candidate's own uploaded resume was never run through these checks, and
 * refusing to submit it would block every candidate who has not opted into
 * tailoring — turning a quality gate into an outage. Only a document that was
 * checked and failed is refused.
 */
export class AtsChecksFailedError extends Error {
  constructor(documentId: string, detail: string) {
    super(
      "ATS_CHECKS_FAILED: the resume document " +
        documentId +
        " did not pass the ATS/format quality checks and will not be submitted. " +
        detail,
    );
    this.name = "AtsChecksFailedError";
  }
}

interface StoredAtsChecks {
  passed?: boolean;
  checks?: Array<{ id: string; passed: boolean; detail: string }>;
}

async function assertAtsChecksPassed(client: SupabaseClient, resume: SubmissionResume): Promise<void> {
  const { data, error } = await client
    .from("resume_documents")
    .select("ats_checks")
    .eq("id", resume.documentId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const stored = (data as { ats_checks: StoredAtsChecks | null } | null)?.ats_checks ?? null;

  if (!stored || stored.passed !== false) {
    return;
  }

  const failed = (stored.checks ?? [])
    .filter((check) => !check.passed)
    .map((check) => check.id + " (" + check.detail + ")")
    .join("; ");

  throw new AtsChecksFailedError(resume.documentId, failed === "" ? "no check detail recorded" : failed);
}

/**
 * The exported entry point: resolve, then refuse anything the ATS checks already
 * rejected. Wrapping the resolver rather than threading the assertion through
 * each of its three return paths means a fourth path added later cannot forget
 * it — the checks are enforced on the way OUT of this module, whatever produced
 * the document.
 */
export async function resolveSubmissionResume(
  client: SupabaseClient,
  deps: ResumeForSubmissionDeps,
  input: ResolveSubmissionResumeInput,
): Promise<SubmissionResume> {
  const resume = await resolveSubmissionResumeUnchecked(client, deps, input);
  await assertAtsChecksPassed(client, resume);
  return resume;
}

export type { Browser };
