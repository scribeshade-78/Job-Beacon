import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import {
  generateResumePayload,
  isGroundedText,
  loadJobDescription,
  NoConfirmedFactsError,
  verifyGroundedClaims,
  type GroundedText,
  type ResumeFactEntry,
} from "./resumeGenerator.js";

/**
 * Task B1 — AI cover letter generation.
 *
 * BACKEND ONLY. Nothing in this phase renders a letter, attaches one to a
 * submission, or writes to application_attempts; the storage column exists and
 * this module is the thing that would fill it. Kept deliberately separate from
 * resumeGenerator.ts because the two artifacts are different shapes — a resume
 * is sections of bullets, a letter is prose paragraphs — while sharing the one
 * thing that must not be reimplemented: the citation gate.
 *
 * THE HONESTY GATE IS THE SAME FUNCTION, NOT A COPY. verifyGroundedClaims is
 * imported from the resume generator rather than re-expressed here. A cover
 * letter is the single easiest place in this entire product to fabricate: it is
 * free prose addressed to an employer, it is written on the candidate's behalf,
 * and unlike a resume there is no structured fact list next to it for a reader
 * to check against. Two paraphrases of "every claim must cite a confirmed fact"
 * would eventually disagree, and the one that rotted would be this one.
 */

/**
 * v3 (Mini-Phase 2): makes the closing paragraph explicitly optional, after a
 * live run showed the model writing one the gate then refused.
 *
 * The first live generation with v2 produced a two-paragraph letter, then a
 * closing — "I look forward to the opportunity to contribute to your team and
 * leverage my skills in a software engineering capacity." — carrying no
 * citations. The gate refused the entire letter, correctly: that sentence is a
 * claim about the candidate's fitness that no confirmed fact supports. But the
 * prompt had asked for "a brief, plain closing", so the model was being told to
 * write something the gate would not accept. v3 states the consequence instead
 * of inviting the failure.
 *
 * v2 (Mini-Phase 2): forbids stating the candidate's own name and contact
 * details in the body.
 *
 * WHY THIS IS A PROMPT FIX AND NOT A GATE FIX. Mini-Phase 1's live run produced
 * a letter opening "KOLAPALLI KRISHNA SRAVANI is well-suited for...", citing
 * only the job-title and years-of-experience facts. The gate passed it, and
 * correctly: the name IS a confirmed fact, and the gate checks that citations
 * are real rather than that every noun is covered by the cited ones. Entity
 * extraction over generated prose would be the way to check that, and it is a
 * much larger change than this phase warrants.
 *
 * The cheaper and better fix is to never need the check: the name is passed
 * structurally on the application, so a letter body has no reason to contain
 * it. Removing the possibility beats detecting it. This does NOT close the
 * general entity loophole — a paragraph could still cite a real fact and
 * mention an unrelated real thing — it closes the one instance that actually
 * occurred and that the structural data makes unnecessary.
 */
export const COVER_LETTER_PROMPT_VERSION = "cover-letter-v3";
export const DEFAULT_COVER_LETTER_MODEL = "openai/gpt-4o-mini";

/** Three short paragraphs, per the phase spec. Enforced on the response, not merely asked for. */
export const MAX_COVER_LETTER_PARAGRAPHS = 3;

/**
 * A soft length ceiling per paragraph.
 *
 * Enforced by refusing an over-long letter rather than truncating it: cutting a
 * paragraph mid-sentence produces text the model did not write and the
 * candidate did not read, which is worse than a failed generation the caller
 * can retry.
 */
export const MAX_PARAGRAPH_CHARS = 900;

export const COVER_LETTER_SYSTEM_PROMPT = [
  "You write a short cover letter for one specific job application, on behalf of a candidate.",
  "",
  "You are given the candidate's CONFIRMED facts. They are the only source of truth about this person.",
  "",
  "STRUCTURE — at most three short paragraphs, in this order:",
  "1. Why this candidate for this role, grounded in what the facts show.",
  "2. The most relevant evidence from the facts for this particular posting.",
  "3. Optionally, a third paragraph — but only if you can cite it.",
  "",
  "The closing is where this goes wrong, so read this carefully. A social",
  "closing with nothing factual in it (\"I look forward to hearing from you\",",
  "\"I am excited about the opportunity\") has no citation, and the whole letter",
  "is discarded rather than that paragraph being dropped. If your closing would",
  "be pure pleasantry, write two paragraphs instead. A closing that names the",
  "role or something the facts actually show IS citable and is fine.",
  "",
  "What you MUST NOT do:",
  "- Do not add any employer, job title, date, qualification, metric, technology or",
  "  achievement that is not named in the confirmed facts.",
  "- Do not claim enthusiasm, motivation or personal history the facts do not show.",
  "  You are not told how the candidate feels about this company; do not write as",
  "  though you were.",
  "- Do not upgrade a claim. 'Familiar with' must not become 'expert in'.",
  "- Do not infer a skill from a job title or an employer name.",
  "- Do not address a named person. No hiring manager name is provided, and",
  "  inventing one addresses the letter to a stranger.",
  "- Do not state the candidate's own name, email address, phone number or any",
  "  other contact detail in the body. Those are supplied separately on the",
  "  application itself, so restating them adds nothing and the facts you are",
  "  given may not include them at all. Write in the first person: 'I', not the",
  "  candidate's name.",
  "- Do not open with a salutation or close with a signature block. You are",
  "  writing the body paragraphs only.",
  "",
  "Every paragraph is a claim, so every paragraph carries its own citations.",
  "The shape is:",
  '  {"paragraphs": [{"text": string, "factRefs": string[]}]}',
  "Each factRefs array names the extractedFactIds that paragraph was written from.",
  "A paragraph you cannot cite must not be written: return fewer paragraphs, or",
  'return it as {"text": "", "factRefs": []} and it will be left out.',
  "Reply with JSON only.",
].join("\n");

export interface CoverLetterContent {
  paragraphs: GroundedText[];
}

/** Every claim in a letter, flattened, so validation has one list to walk. */
export function allCoverLetterClaims(content: CoverLetterContent): GroundedText[] {
  return content.paragraphs;
}

export class MalformedCoverLetterError extends Error {
  constructor(detail: string) {
    super(`Cover letter response was not usable: ${detail}`);
    this.name = "MalformedCoverLetterError";
  }
}

function isValidCoverLetterContent(value: unknown): value is CoverLetterContent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CoverLetterContent>;
  return Array.isArray(candidate.paragraphs) && candidate.paragraphs.every(isGroundedText);
}

function renderCoverLetterInput(
  facts: ResumeFactEntry[],
  job: { title: string; jdText: string | null },
): string {
  const factLines = facts.map((fact) => `- [${fact.extractedFactId}] (${fact.factType}) ${fact.factValue}`);

  return [
    "CONFIRMED FACTS (the only permitted source about the candidate):",
    ...factLines,
    "",
    "THE ROLE BEING APPLIED FOR",
    `Title: ${job.title || "(untitled)"}`,
    job.jdText
      ? `Description:\n${job.jdText}`
      : "Description: none available — write against the title only, and change as little as possible.",
  ].join("\n");
}

export interface GenerateCoverLetterDeps {
  openai: Pick<OpenAI, "chat">;
}

export interface GenerateCoverLetterInput {
  candidateId: string;
  vacancyId: string;
  /** Injectable for deterministic tests; defaults to the env-configured model. */
  model?: string;
}

/**
 * What gets stored alongside the text, so the letter can be audited later.
 *
 * Deliberately the raw citation map rather than a summary of it: the one
 * question anyone will ask of a stored letter is "what backed this sentence?",
 * and answering it needs the per-paragraph fact ids, not a count.
 */
export interface CoverLetterMetadata {
  promptVersion: string;
  modelVersion: string;
  generatedAt: string;
  citedFactCount: number;
  /** One entry per stored paragraph, in order, naming the fact ids it cited. */
  citations: Array<{ paragraphIndex: number; factRefs: string[] }>;
  /** The vacancy the letter was written for, so the pair can be checked later. */
  vacancyId: string;
}

export interface GeneratedCoverLetter {
  /** The paragraphs that are safe to send: non-empty, every one cited. */
  paragraphs: GroundedText[];
  /** The whole letter as it would be stored, paragraphs joined by blank lines. */
  text: string;
  modelVersion: string;
  promptVersion: string;
  /** How many distinct confirmed facts the letter actually drew on. */
  citedFactCount: number;
  /** Everything the row needs to record how this letter came to exist. */
  metadata: CoverLetterMetadata;
}

/**
 * Generates one cover letter, or refuses to.
 *
 * Throws rather than returning a degraded letter at every failure point:
 * NoConfirmedFactsError with nothing to cite, MalformedCoverLetterError on
 * unusable output, UncitedClaimError on a paragraph with no citation, and
 * FabricatedContentError on a citation to a fact that does not exist. Those
 * last two come from the shared gate and are the same errors the resume
 * generator raises, so a caller that already handles one handles both.
 */
export async function generateCoverLetter(
  client: SupabaseClient,
  deps: GenerateCoverLetterDeps,
  input: GenerateCoverLetterInput,
): Promise<GeneratedCoverLetter> {
  // Same confirmed-facts read the resume path uses, so a letter can never cite
  // a fact the candidate has not confirmed — including a corrected value, which
  // generateResumePayload already prefers over the raw extraction.
  const payload = await generateResumePayload(client, input.candidateId);
  const confirmedIds = new Set(payload.facts.map((fact) => fact.extractedFactId));

  const job = await loadJobDescription(client, input.vacancyId);

  const model =
    input.model ??
    process.env.COVER_LETTER_MODEL ??
    process.env.OPENAI_MODEL ??
    process.env.OPENROUTER_MODEL ??
    DEFAULT_COVER_LETTER_MODEL;

  const completion = await deps.openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: COVER_LETTER_SYSTEM_PROMPT },
      { role: "user", content: renderCoverLetterInput(payload.facts, job) },
    ],
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    throw new MalformedCoverLetterError("empty response content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new MalformedCoverLetterError("response content was not valid JSON");
  }

  if (!isValidCoverLetterContent(parsed)) {
    throw new MalformedCoverLetterError("response did not match the expected cover letter schema");
  }

  // The shape bound is enforced, not merely requested in the prompt: a fourth
  // paragraph is a letter that is not the one that was asked for, and silently
  // trimming it would send text the model chose not to prioritise.
  const nonEmpty = parsed.paragraphs.filter((paragraph) => paragraph.text.trim().length > 0);

  if (nonEmpty.length > MAX_COVER_LETTER_PARAGRAPHS) {
    throw new MalformedCoverLetterError(
      `the model returned ${nonEmpty.length} paragraphs, and a cover letter is at most ${MAX_COVER_LETTER_PARAGRAPHS} paragraphs`,
    );
  }

  const tooLong = nonEmpty.find((paragraph) => paragraph.text.trim().length > MAX_PARAGRAPH_CHARS);

  if (tooLong) {
    throw new MalformedCoverLetterError(
      `a paragraph ran to ${tooLong.text.trim().length} characters, past the ${MAX_PARAGRAPH_CHARS}-character ceiling`,
    );
  }

  // THE HONESTY GATE — the same call the resume generator makes, over the same
  // shape of claim list. Runs before the emptiness check so a letter that
  // fabricated something is refused for fabricating, not for being empty.
  const { citedFactCount } = verifyGroundedClaims(nonEmpty, confirmedIds);

  if (nonEmpty.length === 0) {
    throw new MalformedCoverLetterError("every paragraph came back empty, so there is nothing to send");
  }

  const trimmed = nonEmpty.map((paragraph) => ({ ...paragraph, text: paragraph.text.trim() }));

  return {
    paragraphs: trimmed,
    text: trimmed.map((paragraph) => paragraph.text).join("\n\n"),
    modelVersion: model,
    promptVersion: COVER_LETTER_PROMPT_VERSION,
    citedFactCount,
    metadata: {
      promptVersion: COVER_LETTER_PROMPT_VERSION,
      modelVersion: model,
      generatedAt: new Date().toISOString(),
      citedFactCount,
      citations: trimmed.map((paragraph, index) => ({ paragraphIndex: index, factRefs: paragraph.factRefs })),
      vacancyId: input.vacancyId,
    },
  };
}

export { NoConfirmedFactsError };
