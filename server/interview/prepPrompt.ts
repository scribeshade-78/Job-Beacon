import type OpenAI from "openai";
import { sanitizeUntrustedContent, wrapUntrustedContent } from "../security/sanitize.js";

/**
 * Interview Preparation Phase 1 — tailored question generation.
 *
 * Same shape as server/opportunities/fitPrompt.ts and
 * server/mailbox/classifyMessage.ts: a versioned prompt, a strict json_schema
 * response_format, and an independent hand-written validator. The model's
 * structured output is never trusted blindly — a malformed response is
 * rejected outright rather than partially returned or repaired.
 *
 * THE GROUNDING RULE IS THE POINT OF THIS MODULE. Every question is generated
 * from the job description, and every STAR component must be traceable to a
 * CONFIRMED candidate fact. A STAR talking point is the highest fabrication
 * risk in the whole feature: it is first-person prose about the candidate's own
 * history, and a model asked to produce one will invent a plausible project
 * rather than admit the input has nothing to work from. The prompt therefore
 * permits an EMPTY STRING for any STAR component the confirmed facts do not
 * support, and instructs the model to emit fewer talking points rather than
 * pad them. An empty component is honest; an invented one would be handed to a
 * candidate as something to say in an interview.
 *
 * That is also why this module never sees raw extracted facts — only facts the
 * candidate has confirmed (see interviewPrep.ts).
 */

export const INTERVIEW_PREP_PROMPT_VERSION = "interview-prep-v1";
export const DEFAULT_INTERVIEW_PREP_MODEL = "openai/gpt-4o-mini";

/** Upper bounds, so a runaway response is rejected rather than returned whole. */
export const MAX_TECHNICAL_QUESTIONS = 10;
export const MAX_BEHAVIORAL_QUESTIONS = 8;
export const MAX_STAR_POINTS = 6;

export interface TechnicalQuestion {
  question: string;
  /** The JD requirement this question probes. */
  topic: string;
  /** Why the interviewer is likely to ask it, citing the JD. */
  why: string;
}

export interface BehavioralQuestion {
  question: string;
  /** The competency being assessed (e.g. "conflict resolution"). */
  competency: string;
  why: string;
}

/**
 * Every component after `question` may be an empty string. Empty means "the
 * confirmed facts did not support this", which is a valid and expected value —
 * not a malformed response.
 */
export interface StarTalkingPoint {
  question: string;
  situation: string;
  task: string;
  action: string;
  result: string;
}

export interface RawInterviewPrep {
  technical_questions: TechnicalQuestion[];
  behavioral_questions: BehavioralQuestion[];
  star_talking_points: StarTalkingPoint[];
  /** JD requirements with no supporting confirmed fact. Short exact JD phrases. */
  gaps: string[];
}

export interface InterviewPrepInput {
  /** Cleaned JD text (vacancy_jd_snapshots.clean_text). Must be non-empty. */
  jdText: string;
  /** One line per CONFIRMED candidate fact: "type: effective value". May be empty. */
  factLines: string[];
  roleTitle: string;
}

export class MalformedInterviewPrepError extends Error {
  constructor(detail: string) {
    super(`Interview prep returned malformed output: ${detail}`);
    this.name = "MalformedInterviewPrepError";
  }
}

const SYSTEM_PROMPT = `You help a candidate prepare for an interview for one specific job.

You are given a job description and the candidate's CONFIRMED resume facts. Generate:
- technical_questions: questions an interviewer would plausibly ask to test the JD's technical requirements. "topic" must name a specific requirement from the JD. "why" explains what the interviewer is probing for.
- behavioral_questions: questions about how the candidate works with others. "competency" names the trait being assessed.
- star_talking_points: for the most likely behavioral questions, a STAR skeleton (situation, task, action, result) the candidate could tell.
- gaps: JD requirements that have NO supporting confirmed fact. Short exact phrases from the JD. [] if none.

Grounding rules — these override everything else:
- Use ONLY the job description and the CONFIRMED facts provided. Never invent a qualification, employer, project, metric, date, or technology that the facts do not state.
- A STAR talking point describes the CANDIDATE'S OWN history, so the fabrication risk is highest here. Every situation, task, action and result you write MUST be assembled from confirmed facts. You may structure and phrase them, but you may not add detail they do not contain.
- If the confirmed facts are too thin to support a component, return an EMPTY STRING for that component. Never write a placeholder, never guess, never write "example" content.
- If the confirmed facts cannot support a STAR point at all, emit FEWER star_talking_points — including none. An empty list is a correct answer; an invented story is not.
- If no facts are confirmed, still generate technical_questions and behavioral_questions from the JD alone, leave star_talking_points empty, and list the JD's key requirements under gaps.
- Phrase questions as an interviewer would ask them, not as advice to the candidate.
- At most ${MAX_TECHNICAL_QUESTIONS} technical questions, ${MAX_BEHAVIORAL_QUESTIONS} behavioral questions, ${MAX_STAR_POINTS} STAR points.

Output must match the provided JSON schema exactly.`;

const TECHNICAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    question: { type: "string" },
    topic: { type: "string" },
    why: { type: "string" },
  },
  required: ["question", "topic", "why"],
};

const BEHAVIORAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    question: { type: "string" },
    competency: { type: "string" },
    why: { type: "string" },
  },
  required: ["question", "competency", "why"],
};

const STAR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    question: { type: "string" },
    situation: { type: "string" },
    task: { type: "string" },
    action: { type: "string" },
    result: { type: "string" },
  },
  required: ["question", "situation", "task", "action", "result"],
};

const INTERVIEW_PREP_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "interview_prep_v1",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        technical_questions: { type: "array", items: TECHNICAL_SCHEMA },
        behavioral_questions: { type: "array", items: BEHAVIORAL_SCHEMA },
        star_talking_points: { type: "array", items: STAR_SCHEMA },
        gaps: { type: "array", items: { type: "string" } },
      },
      required: ["technical_questions", "behavioral_questions", "star_talking_points", "gaps"],
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty after trimming — used for fields that must carry real content. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * May be empty. STAR components are the only fields allowed to be blank,
 * because a blank component is how the model reports "the facts did not
 * support this" instead of inventing something.
 */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isTechnicalQuestion(value: unknown): value is TechnicalQuestion {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.question) && isNonEmptyString(value.topic) && isString(value.why);
}

function isBehavioralQuestion(value: unknown): value is BehavioralQuestion {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.question) && isNonEmptyString(value.competency) && isString(value.why);
}

function isStarTalkingPoint(value: unknown): value is StarTalkingPoint {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.question) &&
    isString(value.situation) &&
    isString(value.task) &&
    isString(value.action) &&
    isString(value.result)
  );
}

/**
 * Independent shape check — deliberately not a re-statement of the schema sent
 * to the API. Malformed AI output is rejected outright, never partially used.
 *
 * Requires at least one technical and one behavioral question: those depend only
 * on the JD, which is guaranteed non-empty by the caller. star_talking_points is
 * allowed to be empty, because it depends on confirmed facts the candidate may
 * simply not have yet.
 */
export function isValidRawInterviewPrep(value: unknown): value is RawInterviewPrep {
  if (!isRecord(value)) {
    return false;
  }

  const technical = value.technical_questions;
  const behavioral = value.behavioral_questions;
  const star = value.star_talking_points;

  if (!Array.isArray(technical) || !technical.every(isTechnicalQuestion)) return false;
  if (!Array.isArray(behavioral) || !behavioral.every(isBehavioralQuestion)) return false;
  if (!Array.isArray(star) || !star.every(isStarTalkingPoint)) return false;

  if (technical.length === 0 || technical.length > MAX_TECHNICAL_QUESTIONS) return false;
  if (behavioral.length === 0 || behavioral.length > MAX_BEHAVIORAL_QUESTIONS) return false;
  if (star.length > MAX_STAR_POINTS) return false;

  if (!isStringArray(value.gaps)) return false;

  return true;
}

/**
 * The JD is scraped from a third-party board and is the most
 * attacker-controllable text this product feeds a model — a posting may contain
 * anything, including text addressed at the model. It is sanitized and wrapped
 * exactly as the fit-analysis and mailbox prompts do.
 *
 * The role title is left unwrapped: it comes from the vacancy record, not the
 * posting body, and is a single line read as a heading.
 *
 * The fact lines are NOT wrapped. They are the candidate's own confirmed data,
 * written by the extraction pipeline rather than by a third party, and the
 * candidate has reviewed each one.
 */
function renderInput(input: InterviewPrepInput): string {
  const jd = sanitizeUntrustedContent(input.jdText, { html: true }).text;

  return [
    `ROLE: ${input.roleTitle}`,
    "",
    "JOB DESCRIPTION:",
    wrapUntrustedContent("JOB DESCRIPTION", jd),
    "",
    "CANDIDATE CONFIRMED FACTS:",
    input.factLines.length > 0
      ? input.factLines.map((line) => `- ${line}`).join("\n")
      : "(none confirmed — generate questions from the job description alone and leave the STAR talking points empty)",
  ].join("\n");
}

/**
 * `openaiClient` is narrowed to just `chat` — same "accept only what's used"
 * injection shape as analyzeTechnicalFit — so a test injects a minimal fake
 * without constructing a real OpenAI instance.
 */
export async function generateInterviewPrep(
  openaiClient: Pick<OpenAI, "chat">,
  input: InterviewPrepInput,
  model: string = process.env.INTERVIEW_PREP_MODEL ??
    process.env.OPENAI_MODEL ??
    process.env.OPENROUTER_MODEL ??
    DEFAULT_INTERVIEW_PREP_MODEL,
): Promise<RawInterviewPrep> {
  const completion = await openaiClient.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: renderInput(input) },
    ],
    response_format: INTERVIEW_PREP_RESPONSE_FORMAT,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new MalformedInterviewPrepError("empty response content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new MalformedInterviewPrepError("response content was not valid JSON");
  }

  if (!isValidRawInterviewPrep(parsed)) {
    throw new MalformedInterviewPrepError("response did not match the expected interview-prep schema");
  }

  return parsed;
}
