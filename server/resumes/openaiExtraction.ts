import type OpenAI from "openai";

/**
 * MP-F1 v0 fact vocabulary — approved by the founder for this mini-phase.
 * No PRD-defined fact taxonomy exists yet (same "nothing fixed to enumerate
 * against" gap extracted_facts.sql's own comment documents), so this is an
 * explicit, code-owned vocabulary, not a guess at a hidden standard.
 * Scalar fields are 0-or-1 fact per resume; skills/education/experience are
 * repeatable (0..N rows each) since extracted_facts has no unique
 * constraint on (candidate_id, fact_type).
 */
export const DEFAULT_OPENAI_MODEL = "openai/gpt-4o-mini";
export const EXTRACTION_PROMPT_VERSION = "resume-extraction-v1";

export interface RawEducationEntry {
  degree: string | null;
  institution: string | null;
  year: string | null;
}

export interface RawExperienceEntry {
  title: string | null;
  company: string | null;
  duration: string | null;
}

export interface RawExtractionResult {
  full_name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  current_title: string | null;
  years_of_experience: number | null;
  most_recent_employer: string | null;
  skills: string[];
  education: RawEducationEntry[];
  experience: RawExperienceEntry[];
}

export class MalformedExtractionError extends Error {
  constructor(detail: string) {
    super(`OpenAI resume extraction returned malformed output: ${detail}`);
    this.name = "MalformedExtractionError";
  }
}

const SYSTEM_PROMPT = `You extract structured facts from a candidate's resume text.

Rules:
- Only report a fact if the resume text actually states or clearly implies it.
- If a field cannot be determined from the text, output null for it (or an
  empty array for skills/education/experience) — never guess, infer beyond
  the text, or invent a plausible-sounding value.
- years_of_experience is a whole number of years if the resume states or
  makes it directly computable (e.g. explicit total, or start/end years for
  a single continuous role); otherwise null.
- Every education/experience entry must have at least one non-null field —
  do not emit empty placeholder entries.
- Output must match the provided JSON schema exactly.`;

const EXTRACTION_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "resume_facts_v1",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        full_name: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        location: { type: ["string", "null"] },
        current_title: { type: ["string", "null"] },
        years_of_experience: { type: ["number", "null"] },
        most_recent_employer: { type: ["string", "null"] },
        skills: { type: "array", items: { type: "string" } },
        education: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              degree: { type: ["string", "null"] },
              institution: { type: ["string", "null"] },
              year: { type: ["string", "null"] },
            },
            required: ["degree", "institution", "year"],
          },
        },
        experience: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: ["string", "null"] },
              company: { type: ["string", "null"] },
              duration: { type: ["string", "null"] },
            },
            required: ["title", "company", "duration"],
          },
        },
      },
      required: [
        "full_name",
        "email",
        "phone",
        "location",
        "current_title",
        "years_of_experience",
        "most_recent_employer",
        "skills",
        "education",
        "experience",
      ],
    },
  },
};

const EXPECTED_KEYS = [
  "full_name",
  "email",
  "phone",
  "location",
  "current_title",
  "years_of_experience",
  "most_recent_employer",
  "skills",
  "education",
  "experience",
] as const;

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isEducationEntry(value: unknown): value is RawEducationEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    Object.keys(entry).length === 3 &&
    isStringOrNull(entry.degree) &&
    isStringOrNull(entry.institution) &&
    isStringOrNull(entry.year)
  );
}

function isExperienceEntry(value: unknown): value is RawExperienceEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    Object.keys(entry).length === 3 &&
    isStringOrNull(entry.title) &&
    isStringOrNull(entry.company) &&
    isStringOrNull(entry.duration)
  );
}

/**
 * Defense in depth: even though the OpenAI call requests strict JSON-schema
 * structured output, this repository's own rule ("malformed AI output must
 * be rejected, never partial-inserted") means the response is never trusted
 * blindly — this is an independent, from-scratch shape check, not a
 * re-statement of the schema passed to the API.
 */
export function isValidRawExtractionResult(value: unknown): value is RawExtractionResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);

  if (keys.length !== EXPECTED_KEYS.length || !EXPECTED_KEYS.every((key) => keys.includes(key))) {
    return false;
  }

  if (
    !isStringOrNull(record.full_name) ||
    !isStringOrNull(record.email) ||
    !isStringOrNull(record.phone) ||
    !isStringOrNull(record.location) ||
    !isStringOrNull(record.current_title) ||
    !isStringOrNull(record.most_recent_employer)
  ) {
    return false;
  }

  if (record.years_of_experience !== null && typeof record.years_of_experience !== "number") {
    return false;
  }

  if (!Array.isArray(record.skills) || !record.skills.every((skill) => typeof skill === "string")) {
    return false;
  }

  if (!Array.isArray(record.education) || !record.education.every(isEducationEntry)) {
    return false;
  }

  if (!Array.isArray(record.experience) || !record.experience.every(isExperienceEntry)) {
    return false;
  }

  return true;
}

/**
 * `openaiClient` is narrowed to just `chat` — the same "accept only what's
 * used" shape as every SupabaseClient parameter elsewhere in this repo —
 * so a test can inject a minimal fake without constructing a real OpenAI
 * instance.
 */
export async function runResumeFactExtraction(
  openaiClient: Pick<OpenAI, "chat">,
  resumeText: string,
  model: string = process.env.OPENAI_MODEL ?? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENAI_MODEL,
): Promise<RawExtractionResult> {
  const completion = await openaiClient.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: resumeText },
    ],
    response_format: EXTRACTION_RESPONSE_FORMAT,
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    throw new MalformedExtractionError("empty response content");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new MalformedExtractionError("response content was not valid JSON");
  }

  if (!isValidRawExtractionResult(parsed)) {
    throw new MalformedExtractionError("response did not match the expected extraction schema");
  }

  return parsed;
}
