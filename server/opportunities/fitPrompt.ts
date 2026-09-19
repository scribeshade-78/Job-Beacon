import type OpenAI from "openai";
import { sanitizeUntrustedContent, wrapUntrustedContent } from "../security/sanitize.js";

/**
 * Response Intelligence Phase 2.1 — Technical Fit analysis (Opportunity
 * Intelligence PRD §11.2 Resume Match Breakdown). Same shape as
 * server/mailbox/classifyMessage.ts: a versioned prompt, a strict
 * json_schema response_format, and an independent hand-written validator
 * (the model's structured output is never trusted blindly).
 *
 * The AI scores technical fit across the six §11.2 dimensions and lists
 * "missing evidence" (JD-required, absent from the confirmed facts). It
 * never emits reason codes — `risks` is free text; deterministic reason
 * codes are the rules engine's job (practicalEligibility.ts).
 */

export const FIT_ANALYSIS_PROMPT_VERSION = "fit-analysis-v1";
export const DEFAULT_FIT_MODEL = "openai/gpt-4o-mini";

export const FIT_DIMENSIONS = [
  "core_technical_skills",
  "cloud_alignment",
  "engineering_responsibilities",
  "scale_performance_evidence",
  "seniority",
  "domain",
] as const;

export type FitDimension = (typeof FIT_DIMENSIONS)[number];

export interface FitComponent {
  score: number;
  rationale: string;
}

export interface RawFitAnalysis {
  overall: number;
  components: Record<FitDimension, FitComponent>;
  missing_evidence: string[];
  top_reasons: string[];
  risks: string[];
}

export interface FitAnalysisInput {
  /** Cleaned JD text (vacancy_jd_snapshots.clean_text). Must be non-empty. */
  jdText: string;
  /** Section headings, for light structure in the prompt. */
  sectionHeadings: string[];
  /** One bullet per confirmed candidate fact: "type: effective value". */
  factLines: string[];
  roleTitle: string;
}

export class MalformedFitAnalysisError extends Error {
  constructor(detail: string) {
    super(`Fit analysis returned malformed output: ${detail}`);
    this.name = "MalformedFitAnalysisError";
  }
}

const SYSTEM_PROMPT = `You compare one job description against a candidate's CONFIRMED resume facts and score technical fit.

Score six dimensions, each 0-100 with a one-sentence rationale that cites specific JD text against a specific fact:
- core_technical_skills: languages, frameworks, tools the JD requires vs. the facts.
- cloud_alignment: cloud platform / infra alignment (AWS/GCP/Azure/k8s/etc.).
- engineering_responsibilities: the day-to-day responsibilities the JD describes vs. the candidate's demonstrated scope.
- scale_performance_evidence: evidence of working at the scale / performance bar the JD implies.
- seniority: the seniority the JD targets vs. the candidate's years and level.
- domain: industry / problem-domain overlap.

Rules:
- Score ONLY on evidence present in the inputs. Never invent a qualification the facts do not state.
- missing_evidence: skills or requirements the JD explicitly requires that are ABSENT from the facts. Use short exact phrases from the JD. [] if none.
- overall: 0-100, your holistic technical-fit judgement (not necessarily the mean).
- top_reasons: up to 3 short strings — why this is or is not a fit.
- risks: up to 3 short strings — concerns the candidate should know. You MAY note work-authorisation, security-clearance, or payroll-country language you see in the JD here; that is advisory only.

Output must match the provided JSON schema exactly.`;

const COMPONENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "number" },
    rationale: { type: "string" },
  },
  required: ["score", "rationale"],
};

const FIT_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "fit_analysis_v1",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        overall: { type: "number" },
        components: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(FIT_DIMENSIONS.map((d) => [d, COMPONENT_SCHEMA])),
          required: [...FIT_DIMENSIONS],
        },
        missing_evidence: { type: "array", items: { type: "string" } },
        top_reasons: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
      },
      required: ["overall", "components", "missing_evidence", "top_reasons", "risks"],
    },
  },
};

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Independent shape check — not a re-statement of the schema sent to the
 * API. Malformed AI output is rejected outright, never partially stored.
 */
export function isValidRawFitAnalysis(value: unknown): value is RawFitAnalysis {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;

  if (!isScore(record.overall)) {
    return false;
  }
  if (!isStringArray(record.missing_evidence) || !isStringArray(record.top_reasons) || !isStringArray(record.risks)) {
    return false;
  }

  const components = record.components;
  if (typeof components !== "object" || components === null || Array.isArray(components)) {
    return false;
  }
  const compRecord = components as Record<string, unknown>;
  const keys = Object.keys(compRecord);
  if (keys.length !== FIT_DIMENSIONS.length) {
    return false;
  }
  for (const dim of FIT_DIMENSIONS) {
    const comp = compRecord[dim];
    if (typeof comp !== "object" || comp === null || Array.isArray(comp)) {
      return false;
    }
    const c = comp as Record<string, unknown>;
    if (!isScore(c.score) || typeof c.rationale !== "string") {
      return false;
    }
  }

  return true;
}

/**
 * Task H4, RI PRD §10.3: "JD ... text are data, never trusted instructions".
 *
 * A job description is scraped from a third-party board, which makes it the most
 * attacker-controllable text this product feeds a model — a posting is free to
 * contain anything, and it is read by a call that decides whether the candidate
 * applies. The JD is therefore sanitized and wrapped exactly as the email body is.
 *
 * The role title is left alone: it comes from the vacancy record rather than from
 * the posting body, and it is a single line the model reads as a heading.
 */
function renderInput(input: FitAnalysisInput): string {
  const jd = sanitizeUntrustedContent(input.jdText, { html: true }).text;

  return [
    `ROLE: ${input.roleTitle}`,
    "",
    "JOB DESCRIPTION:",
    input.sectionHeadings.length > 0 ? `(sections: ${input.sectionHeadings.join(" | ")})` : "",
    wrapUntrustedContent("JOB DESCRIPTION", jd),
    "",
    "CANDIDATE CONFIRMED FACTS:",
    input.factLines.length > 0 ? input.factLines.map((l) => `- ${l}`).join("\n") : "(none confirmed)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * `openaiClient` is narrowed to just `chat` — same "accept only what's
 * used" injection shape as classifyMessageContent — so a test injects a
 * minimal fake without constructing a real OpenAI instance.
 */
export async function analyzeTechnicalFit(
  openaiClient: Pick<OpenAI, "chat">,
  input: FitAnalysisInput,
  model: string = process.env.FIT_ANALYSIS_MODEL ??
    process.env.OPENAI_MODEL ??
    process.env.OPENROUTER_MODEL ??
    DEFAULT_FIT_MODEL,
): Promise<RawFitAnalysis> {
  const completion = await openaiClient.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: renderInput(input) },
    ],
    response_format: FIT_RESPONSE_FORMAT,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new MalformedFitAnalysisError("empty response content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new MalformedFitAnalysisError("response content was not valid JSON");
  }

  if (!isValidRawFitAnalysis(parsed)) {
    throw new MalformedFitAnalysisError("response did not match the expected fit-analysis schema");
  }

  return parsed;
}
