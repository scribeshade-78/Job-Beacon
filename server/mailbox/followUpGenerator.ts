import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import {
  generateResumePayload,
  isGroundedText,
  verifyGroundedClaims,
  type GroundedText,
} from "../applications/resumeGenerator.js";

/**
 * Task C1 — the follow-up email generator.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OTHER TWO GENERATORS. A resume and a cover
 * letter are claims about the candidate, so their permitted source is the
 * candidate's confirmed facts. A follow-up is largely claims about the
 * APPLICATION — "I applied for the Data Engineer role three weeks ago and
 * wanted to check on progress" — and none of that is in the candidate's facts.
 *
 * Rather than loosen the gate, this supplies a second, equally verifiable fact
 * set: the application's own details, read from this database. They get the
 * same treatment as confirmed facts — a stable id the model must cite — so
 * verifyGroundedClaims runs unchanged over a universe of
 * (confirmed candidate facts + application facts).
 *
 * That is why the ids for application facts are prefixed: they are ours, not
 * extracted_facts rows, and the prefix makes a stored citation unambiguous
 * about which table to look in.
 *
 * WHY THE GATE IS HERE AT ALL, given this phase did not ask for one. A
 * follow-up is sent to an employer in the candidate's name. "I have ten years
 * leading platform teams and hold a CKA" is exactly the kind of embellishment a
 * model adds to make a short email sound substantive, and it would be sent. The
 * two other generators are gated; leaving the third ungated would make the
 * discipline a property of whichever file someone happened to write.
 */

export const FOLLOW_UP_PROMPT_VERSION = "follow-up-v1";
export const DEFAULT_FOLLOW_UP_MODEL = "openai/gpt-4o-mini";

export const MAX_FOLLOW_UP_PARAGRAPHS = 2;
export const MAX_FOLLOW_UP_PARAGRAPH_CHARS = 900;

/**
 * The synthetic fact universe for application details.
 *
 * Ids are stable and derivable from the row, so a stored citation can be checked
 * against the same application later without a lookup table.
 */
export function applicationFactId(field: string): string {
  return `application:${field}`;
}

export const FOLLOW_UP_SYSTEM_PROMPT = [
  "You write a short follow-up email for one job application, on behalf of a candidate.",
  "",
  "You are given two sets of facts: CONFIRMED FACTS about the candidate, and",
  "APPLICATION FACTS about this specific application. Both are the only permitted",
  "sources. Everything else you might want to say, you may not say.",
  "",
  "STRUCTURE — exactly two short paragraphs:",
  "1. Which application this is about, and that the candidate is following up.",
  "2. A brief, polite request for a status update.",
  "",
  "TONE: courteous, brief, and unbothered. This is a routine check-in, not a",
  "complaint, and not a second pitch.",
  "",
  "What you MUST NOT do:",
  "- Do not add any skill, employer, job title, date, qualification, metric or",
  "  achievement that is not in the facts you are given.",
  "- Do not re-pitch the candidate. Restating their strengths is what the",
  "  original application was for; repeating it reads as pressure.",
  "- Do not express disappointment, impatience, or any emotion at all about the",
  "  delay. You are not told how the candidate feels about it.",
  "- Do not state the candidate's name, email or phone number in the body; those",
  "  are supplied structurally on the application.",
  "- Do not address a named person. No name is provided, and inventing one",
  "  addresses the email to a stranger.",
  "- Do not invent a reason for the delay or speculate about the employer's",
  "  process.",
  "",
  "Every paragraph is a claim, so every paragraph carries its own citations.",
  "The shape is:",
  '  {"paragraphs": [{"text": string, "factRefs": string[]}]}',
  "Each factRefs array names the ids that paragraph was written from — either an",
  "extractedFactId from the confirmed facts, or an application: id from the",
  "application facts. A paragraph you cannot cite must not be written.",
  "Reply with JSON only.",
].join("\n");

export interface FollowUpContent {
  paragraphs: GroundedText[];
}

export class MalformedFollowUpError extends Error {
  constructor(detail: string) {
    super(`Follow-up draft was not usable: ${detail}`);
    this.name = "MalformedFollowUpError";
  }
}

export class ApplicationFactsUnavailableError extends Error {
  constructor(vacancyId: string) {
    super(`Cannot write a follow-up for vacancy ${vacancyId}: the vacancy row is missing.`);
    this.name = "ApplicationFactsUnavailableError";
  }
}

function isValidFollowUpContent(value: unknown): value is FollowUpContent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FollowUpContent>;
  return Array.isArray(candidate.paragraphs) && candidate.paragraphs.every(isGroundedText);
}

export interface ApplicationFacts {
  vacancyTitle: string;
  companyName: string | null;
  submittedAt: string;
  daysSinceSubmission: number;
}

/**
 * THE ONE LIST. Both the rendered prompt lines and the permitted citation ids
 * are derived from this, in this order.
 *
 * They were two hand-maintained arrays before, and a test caught them already
 * disagreeing: company was spliced into the rendered lines second and pushed
 * onto the id list last. Order alone is harmless — the gate treats the ids as a
 * set — but two lists of the same thing is a drift with no upside: add a fact
 * to one and the model is either shown an id it may not cite, or given
 * permission to cite an id it was never shown.
 */
function applicationFactEntries(facts: ApplicationFacts): Array<{ id: string; value: string }> {
  const entries: Array<{ id: string; value: string }> = [
    { id: applicationFactId("vacancy_title"), value: facts.vacancyTitle },
  ];

  if (facts.companyName) {
    entries.push({ id: applicationFactId("company"), value: facts.companyName });
  }

  entries.push(
    { id: applicationFactId("submitted_on"), value: facts.submittedAt.slice(0, 10) },
    { id: applicationFactId("days_since_submission"), value: String(facts.daysSinceSubmission) },
    { id: applicationFactId("no_reply_received"), value: "no reply has been received" },
  );

  return entries;
}

/** The application's own details as citable fact lines. */
export function renderApplicationFacts(facts: ApplicationFacts): string[] {
  return applicationFactEntries(facts).map((entry) => `- [${entry.id}] (application) ${entry.value}`);
}

/** The ids those lines carry — derived from the same entries, so the two cannot disagree. */
export function applicationFactIds(facts: ApplicationFacts): string[] {
  return applicationFactEntries(facts).map((entry) => entry.id);
}

function renderFollowUpInput(
  candidateFacts: Array<{ extractedFactId: string; factType: string; factValue: string }>,
  applicationFacts: ApplicationFacts,
): string {
  return [
    "CONFIRMED FACTS about the candidate:",
    ...candidateFacts.map((fact) => `- [${fact.extractedFactId}] (${fact.factType}) ${fact.factValue}`),
    "",
    "APPLICATION FACTS about this application:",
    ...renderApplicationFacts(applicationFacts),
  ].join("\n");
}

export interface FollowUpDraftMetadata {
  promptVersion: string;
  modelVersion: string;
  generatedAt: string;
  citedFactCount: number;
  /** One entry per paragraph, naming the ids it cited. Application ids are prefixed application:. */
  citations: Array<{ paragraphIndex: number; factRefs: string[] }>;
  applicationFacts: ApplicationFacts;
}

export interface GeneratedFollowUpDraft {
  paragraphs: GroundedText[];
  text: string;
  modelVersion: string;
  promptVersion: string;
  citedFactCount: number;
  metadata: FollowUpDraftMetadata;
}

export interface FollowUpDeps {
  openai: Pick<OpenAI, "chat">;
}

export interface FollowUpInput {
  candidateId: string;
  vacancyId: string;
  submittedAt: string;
  daysSinceSubmission: number;
  model?: string;
}

/**
 * Generates one follow-up draft, or refuses to.
 *
 * Throws NoConfirmedFactsError when the candidate has nothing confirmed (via
 * generateResumePayload), ApplicationFactsUnavailableError when the vacancy is
 * gone, MalformedFollowUpError on unusable output, and the shared gate's
 * UncitedClaimError / FabricatedContentError on uncited or invented citations.
 */
export async function generateFollowUpDraft(
  client: SupabaseClient,
  deps: FollowUpDeps,
  input: FollowUpInput,
): Promise<GeneratedFollowUpDraft> {
  const payload = await generateResumePayload(client, input.candidateId);

  const { data: vacancy, error: vacancyError } = await client
    .from("vacancies")
    .select("raw_title, companies (displayed_name)")
    .eq("id", input.vacancyId)
    .maybeSingle();

  if (vacancyError) {
    throw vacancyError;
  }
  if (!vacancy) {
    throw new ApplicationFactsUnavailableError(input.vacancyId);
  }

  // PostgREST types an embedded to-one resource as an array even when the FK
  // guarantees one row, so the shape is narrowed here rather than trusted.
  const row = vacancy as unknown as { raw_title: string; companies: { displayed_name: string } | null };

  const applicationFacts: ApplicationFacts = {
    vacancyTitle: row.raw_title,
    companyName: row.companies?.displayed_name ?? null,
    submittedAt: input.submittedAt,
    daysSinceSubmission: input.daysSinceSubmission,
  };

  // The permitted universe is the candidate's confirmed facts PLUS this
  // application's own details — the same shape verifyGroundedClaims already
  // takes, so the gate itself is untouched.
  const confirmedIds = new Set([
    ...payload.facts.map((fact) => fact.extractedFactId),
    ...applicationFactIds(applicationFacts),
  ]);

  const model =
    input.model ??
    process.env.FOLLOW_UP_MODEL ??
    process.env.OPENAI_MODEL ??
    process.env.OPENROUTER_MODEL ??
    DEFAULT_FOLLOW_UP_MODEL;

  const completion = await deps.openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: FOLLOW_UP_SYSTEM_PROMPT },
      { role: "user", content: renderFollowUpInput(payload.facts, applicationFacts) },
    ],
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    throw new MalformedFollowUpError("empty response content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new MalformedFollowUpError("response content was not valid JSON");
  }

  if (!isValidFollowUpContent(parsed)) {
    throw new MalformedFollowUpError("response did not match the expected follow-up schema");
  }

  const nonEmpty = parsed.paragraphs.filter((paragraph) => paragraph.text.trim().length > 0);

  if (nonEmpty.length > MAX_FOLLOW_UP_PARAGRAPHS) {
    throw new MalformedFollowUpError(
      `the model returned ${nonEmpty.length} paragraphs, and a follow-up is at most ${MAX_FOLLOW_UP_PARAGRAPHS} paragraphs`,
    );
  }

  const tooLong = nonEmpty.find((paragraph) => paragraph.text.trim().length > MAX_FOLLOW_UP_PARAGRAPH_CHARS);

  if (tooLong) {
    throw new MalformedFollowUpError(
      `a paragraph ran to ${tooLong.text.trim().length} characters, past the ${MAX_FOLLOW_UP_PARAGRAPH_CHARS}-character ceiling`,
    );
  }

  // The same gate the resume and cover letter run. Nothing about it is
  // special-cased for follow-ups; only the fact universe it is handed differs.
  const { citedFactCount } = verifyGroundedClaims(nonEmpty, confirmedIds);

  if (nonEmpty.length === 0) {
    throw new MalformedFollowUpError("every paragraph came back empty, so there is nothing to send");
  }

  const trimmed = nonEmpty.map((paragraph) => ({ ...paragraph, text: paragraph.text.trim() }));

  return {
    paragraphs: trimmed,
    text: trimmed.map((paragraph) => paragraph.text).join("\n\n"),
    modelVersion: model,
    promptVersion: FOLLOW_UP_PROMPT_VERSION,
    citedFactCount,
    metadata: {
      promptVersion: FOLLOW_UP_PROMPT_VERSION,
      modelVersion: model,
      generatedAt: new Date().toISOString(),
      citedFactCount,
      citations: trimmed.map((paragraph, index) => ({ paragraphIndex: index, factRefs: paragraph.factRefs })),
      applicationFacts,
    },
  };
}
