import type OpenAI from "openai";
import { sanitizeUntrustedContent, wrapUntrustedContent } from "../security/sanitize.js";

/**
 * Response Intelligence Phase 1 — message classification + entity
 * extraction. Same shape as resumes/openaiExtraction.ts: a versioned
 * prompt, a strict json_schema response_format, and an independent
 * hand-written validator (defense in depth — the model's structured
 * output is never trusted blindly).
 *
 * The category set is code-owned and founder-approved for this phase.
 * response_classifications.category has no CHECK constraint (the migration
 * deliberately left the taxonomy open), so this const IS the taxonomy
 * until a PRD defines one.
 */
export const MESSAGE_CLASSIFICATION_PROMPT_VERSION = "message-classification-v1";
export const DEFAULT_CLASSIFICATION_MODEL = "openai/gpt-4o-mini";

export const MESSAGE_CATEGORIES = [
  "interview",
  "rejection",
  "offer",
  "action_required",
  "recruiter_followup",
  "application_received",
  "other",
] as const;

export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

export interface MessageClassificationInput {
  sender: string | null;
  subject: string | null;
  /** Plain-text body when available (poll path); null when classifying from headers alone (backfill batch). */
  bodyText: string | null;
}

export interface RawMessageClassification {
  category: MessageCategory;
  confidence: number | null;
  company: string | null;
  role: string | null;
  job_id: string | null;
  /** ISO calendar date (YYYY-MM-DD) or null — never a time, never a relative phrase. */
  deadline: string | null;
  /** Verbatim salary phrasing from the message; never a normalised or computed number. */
  salary_text: string | null;
}

export class MalformedClassificationError extends Error {
  constructor(detail: string) {
    super(`Message classification returned malformed output: ${detail}`);
    this.name = "MalformedClassificationError";
  }
}

const SYSTEM_PROMPT = `You classify a single inbound email in a job seeker's mailbox and extract a few factual entities from it.

category — choose exactly one:
- interview: schedules, proposes, or discusses logistics of an interview / assessment / screening call.
- rejection: states the application will not move forward.
- offer: extends or discusses a job offer.
- action_required: asks the candidate to do something with a deadline or explicit request (submit a document, complete a test, confirm availability) and is not itself an interview scheduling mail.
- recruiter_followup: a recruiter or hiring contact reaching out or following up without any of the above.
- application_received: an acknowledgement that an application was received, under review, or in a queue.
- other: anything else, including mail that is not about a specific application.

Entity rules:
- Only report an entity the email actually states or unambiguously implies. If it is not there, output null. Never guess, never infer a plausible value.
- company: the hiring organisation the email is about.
- role: the job title the email is about.
- job_id: a requisition / posting / reference id if one is quoted.
- deadline: a concrete calendar date the candidate must act by, as YYYY-MM-DD. If only a relative phrase is given ("by end of week") and the email has no date to anchor it, output null.
- salary_text: the salary or compensation phrasing exactly as written (e.g. "12-18 LPA", "£45,000 + equity"). Do not convert, annualise, or pick a midpoint.
- confidence: your confidence in the category, 0 to 1.

Output must match the provided JSON schema exactly.`;

const CLASSIFICATION_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "message_classification_v1",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        category: { type: "string", enum: [...MESSAGE_CATEGORIES] },
        confidence: { type: ["number", "null"] },
        company: { type: ["string", "null"] },
        role: { type: ["string", "null"] },
        job_id: { type: ["string", "null"] },
        deadline: { type: ["string", "null"] },
        salary_text: { type: ["string", "null"] },
      },
      required: ["category", "confidence", "company", "role", "job_id", "deadline", "salary_text"],
    },
  },
};

const EXPECTED_KEYS = [
  "category",
  "confidence",
  "company",
  "role",
  "job_id",
  "deadline",
  "salary_text",
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Independent shape check — not a re-statement of the schema sent to the
 * API. Malformed AI output is rejected outright, never partially stored.
 */
export function isValidRawMessageClassification(value: unknown): value is RawMessageClassification {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);

  if (keys.length !== EXPECTED_KEYS.length || !EXPECTED_KEYS.every((key) => keys.includes(key))) {
    return false;
  }

  if (typeof record.category !== "string" || !MESSAGE_CATEGORIES.includes(record.category as MessageCategory)) {
    return false;
  }

  if (record.confidence !== null && typeof record.confidence !== "number") {
    return false;
  }
  if (typeof record.confidence === "number" && (record.confidence < 0 || record.confidence > 1)) {
    return false;
  }

  if (
    !isStringOrNull(record.company) ||
    !isStringOrNull(record.role) ||
    !isStringOrNull(record.job_id) ||
    !isStringOrNull(record.salary_text)
  ) {
    return false;
  }

  if (!isStringOrNull(record.deadline)) {
    return false;
  }
  if (typeof record.deadline === "string" && !ISO_DATE.test(record.deadline)) {
    return false;
  }

  return true;
}

/**
 * Task H4, RI PRD §10.3: "Email ... text are data, never trusted instructions to
 * the AI agent."
 *
 * The body is sanitized and wrapped BEFORE it reaches the model. Two distinct
 * things happen here and both are load-bearing:
 *
 *   1. sanitizeUntrustedContent removes script and style blocks, inline event
 *      handlers, tracking pixels and active embeds. An HTML-only recruiting email
 *      would otherwise arrive with its markup intact.
 *   2. wrapUntrustedContent prepends the systemic prefix and delimits the block,
 *      so the model is told what the content IS rather than being asked to obey
 *      an order about it.
 *
 * Sender and subject are left as-is: they are single header lines that the model
 * reads as metadata, and rewriting them would change what the classifier is
 * classifying. The body is where instructions can actually hide.
 */
function renderMessage(input: MessageClassificationInput): string {
  const body =
    input.bodyText === null
      ? null
      : sanitizeUntrustedContent(input.bodyText, { html: false }).text;

  return [
    `From: ${input.sender ?? "(unknown)"}`,
    `Subject: ${input.subject ?? "(none)"}`,
    "",
    body === null || body === ""
      ? "(body unavailable — classify from sender and subject only)"
      : wrapUntrustedContent("EMAIL BODY", body),
  ].join("\n");
}

/**
 * `openaiClient` is narrowed to just `chat` — same "accept only what's
 * used" shape as resumes/openaiExtraction.ts — so a test injects a minimal
 * fake without constructing a real OpenAI instance.
 */
export async function classifyMessageContent(
  openaiClient: Pick<OpenAI, "chat">,
  input: MessageClassificationInput,
  model: string = process.env.OPENAI_MODEL ?? process.env.OPENROUTER_MODEL ?? DEFAULT_CLASSIFICATION_MODEL,
): Promise<RawMessageClassification> {
  const completion = await openaiClient.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: renderMessage(input) },
    ],
    response_format: CLASSIFICATION_RESPONSE_FORMAT,
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    throw new MalformedClassificationError("empty response content");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new MalformedClassificationError("response content was not valid JSON");
  }

  if (!isValidRawMessageClassification(parsed)) {
    throw new MalformedClassificationError("response did not match the expected classification schema");
  }

  return parsed;
}
