import type OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INTERVIEW_PREP_MODEL,
  INTERVIEW_PREP_PROMPT_VERSION,
  MalformedInterviewPrepError,
  MAX_BEHAVIORAL_QUESTIONS,
  MAX_STAR_POINTS,
  MAX_TECHNICAL_QUESTIONS,
  generateInterviewPrep,
  isValidRawInterviewPrep,
  type RawInterviewPrep,
} from "./prepPrompt.js";

function validPrep(over: Partial<RawInterviewPrep> = {}): RawInterviewPrep {
  return {
    technical_questions: [
      { question: "How would you tune this query?", topic: "Postgres performance", why: "The JD owns a high-traffic API." },
    ],
    behavioral_questions: [
      { question: "Tell me about a disagreement with a colleague.", competency: "conflict resolution", why: "Cross-team work is central." },
    ],
    star_talking_points: [
      {
        question: "Tell me about a disagreement with a colleague.",
        situation: "A schema migration blocked two teams.",
        task: "Agree a sequence both could ship.",
        action: "Ran a joint review.",
        result: "Shipped in two days.",
      },
    ],
    gaps: [],
    ...over,
  };
}

/** A minimal `Pick<OpenAI, "chat">` fake — never constructs a real client. */
function mockOpenAI(content: string | null) {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content } }] });
  return { client: { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">, create };
}

const INPUT = {
  jdText: "We need a senior platform engineer with Postgres and Go.",
  factLines: ["skill: Postgres", "current_title: Platform Engineer"],
  roleTitle: "Senior Platform Engineer",
};

/** The user message the prompt actually sent to the model. */
function userMessage(create: ReturnType<typeof vi.fn>): string {
  const messages = create.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
  return messages.find((m) => m.role === "user")!.content;
}

/**
 * Captured before any test mutates them. vi.stubEnv cannot express "absent" —
 * stubbing to undefined writes the string "undefined" rather than removing the
 * key — so the model-resolution tests delete the variables and restore the real
 * values here.
 */
const ORIGINAL_MODEL_ENV: Record<string, string | undefined> = {
  INTERVIEW_PREP_MODEL: process.env.INTERVIEW_PREP_MODEL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
};

afterEach(() => {
  vi.unstubAllEnvs();

  for (const [key, value] of Object.entries(ORIGINAL_MODEL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("isValidRawInterviewPrep", () => {
  it("accepts a well-formed payload", () => {
    expect(isValidRawInterviewPrep(validPrep())).toBe(true);
  });

  it("accepts an empty star_talking_points list — thin facts are not malformed", () => {
    expect(isValidRawInterviewPrep(validPrep({ star_talking_points: [] }))).toBe(true);
  });

  it("accepts empty STAR components, which is how the model reports 'facts did not support this'", () => {
    const prep = validPrep({
      star_talking_points: [{ question: "Tell me about a conflict.", situation: "", task: "", action: "", result: "" }],
    });

    expect(isValidRawInterviewPrep(prep)).toBe(true);
  });

  it("rejects a STAR point with a blank question — an unlabelled point has no purpose", () => {
    const prep = validPrep({
      star_talking_points: [{ question: "   ", situation: "s", task: "t", action: "a", result: "r" }],
    });

    expect(isValidRawInterviewPrep(prep)).toBe(false);
  });

  it("rejects zero technical questions — the JD alone guarantees some", () => {
    expect(isValidRawInterviewPrep(validPrep({ technical_questions: [] }))).toBe(false);
  });

  it("rejects zero behavioral questions", () => {
    expect(isValidRawInterviewPrep(validPrep({ behavioral_questions: [] }))).toBe(false);
  });

  it("rejects more technical questions than the cap", () => {
    const many = Array.from({ length: MAX_TECHNICAL_QUESTIONS + 1 }, () => ({
      question: "q",
      topic: "t",
      why: "w",
    }));

    expect(isValidRawInterviewPrep(validPrep({ technical_questions: many }))).toBe(false);
  });

  it("rejects more STAR points than the cap", () => {
    const many = Array.from({ length: MAX_STAR_POINTS + 1 }, () => ({
      question: "q",
      situation: "s",
      task: "t",
      action: "a",
      result: "r",
    }));

    expect(isValidRawInterviewPrep(validPrep({ star_talking_points: many }))).toBe(false);
  });

  it("rejects more behavioral questions than the cap", () => {
    const many = Array.from({ length: MAX_BEHAVIORAL_QUESTIONS + 1 }, () => ({
      question: "q",
      competency: "c",
      why: "w",
    }));

    expect(isValidRawInterviewPrep(validPrep({ behavioral_questions: many }))).toBe(false);
  });

  it("rejects a technical question with no topic", () => {
    const prep = validPrep({ technical_questions: [{ question: "q", topic: "", why: "w" }] });

    expect(isValidRawInterviewPrep(prep)).toBe(false);
  });

  it("rejects non-string gaps", () => {
    const prep = { ...validPrep(), gaps: [1, 2] };

    expect(isValidRawInterviewPrep(prep)).toBe(false);
  });

  it("rejects null, a bare array, and a string", () => {
    expect(isValidRawInterviewPrep(null)).toBe(false);
    expect(isValidRawInterviewPrep([])).toBe(false);
    expect(isValidRawInterviewPrep("{}")).toBe(false);
  });
});

describe("generateInterviewPrep", () => {
  it("returns the parsed payload on a valid response", async () => {
    const prep = validPrep();
    const { client } = mockOpenAI(JSON.stringify(prep));

    await expect(generateInterviewPrep(client, INPUT)).resolves.toEqual(prep);
  });

  it("wraps the job description as untrusted data", async () => {
    const { client, create } = mockOpenAI(JSON.stringify(validPrep()));

    await generateInterviewPrep(client, INPUT);

    // The JD is third-party scraped text and must arrive inside the untrusted
    // boundary, not as bare prose the model could read as instructions.
    const sent = userMessage(create);
    expect(sent).toContain("--- BEGIN JOB DESCRIPTION (untrusted data) ---");
    expect(sent).toContain("--- END JOB DESCRIPTION ---");
    expect(sent).toContain("We need a senior platform engineer with Postgres and Go.");
  });

  it("includes every confirmed fact line", async () => {
    const { client, create } = mockOpenAI(JSON.stringify(validPrep()));

    await generateInterviewPrep(client, INPUT);

    const sent = userMessage(create);
    expect(sent).toContain("- skill: Postgres");
    expect(sent).toContain("- current_title: Platform Engineer");
  });

  it("tells the model explicitly when nothing is confirmed, rather than leaving it blank", async () => {
    const { client, create } = mockOpenAI(JSON.stringify(validPrep({ star_talking_points: [] })));

    await generateInterviewPrep(client, { ...INPUT, factLines: [] });

    const sent = userMessage(create);
    expect(sent).toContain("(none confirmed");
    expect(sent).toContain("leave the STAR talking points empty");
  });

  it("instructs the model not to invent STAR content", async () => {
    const { client, create } = mockOpenAI(JSON.stringify(validPrep()));

    await generateInterviewPrep(client, INPUT);

    const system = (create.mock.calls[0][0].messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === "system",
    )!.content;

    expect(system).toContain("Never invent a qualification");
    expect(system).toContain("EMPTY STRING");
    expect(system).toContain("an invented story is not");
  });

  it("requests the strict json_schema response format", async () => {
    const { client, create } = mockOpenAI(JSON.stringify(validPrep()));

    await generateInterviewPrep(client, INPUT);

    expect(create.mock.calls[0][0].response_format.json_schema.strict).toBe(true);
    expect(create.mock.calls[0][0].response_format.json_schema.name).toBe("interview_prep_v1");
  });

  it("throws on empty response content", async () => {
    const { client } = mockOpenAI(null);

    await expect(generateInterviewPrep(client, INPUT)).rejects.toBeInstanceOf(MalformedInterviewPrepError);
  });

  it("throws when the content is not valid JSON", async () => {
    const { client } = mockOpenAI("not json at all");

    await expect(generateInterviewPrep(client, INPUT)).rejects.toBeInstanceOf(MalformedInterviewPrepError);
  });

  it("throws when the JSON does not match the schema", async () => {
    const { client } = mockOpenAI(JSON.stringify({ technical_questions: [] }));

    await expect(generateInterviewPrep(client, INPUT)).rejects.toBeInstanceOf(MalformedInterviewPrepError);
  });

  it("uses INTERVIEW_PREP_MODEL over the other model variables", async () => {
    vi.stubEnv("INTERVIEW_PREP_MODEL", "vendor/interview-model");
    vi.stubEnv("OPENAI_MODEL", "vendor/openai-model");
    const { client, create } = mockOpenAI(JSON.stringify(validPrep()));

    await generateInterviewPrep(client, INPUT);

    expect(create.mock.calls[0][0].model).toBe("vendor/interview-model");
  });

  it("falls back to DEFAULT_INTERVIEW_PREP_MODEL when nothing is configured", async () => {
    delete process.env.INTERVIEW_PREP_MODEL;
    delete process.env.OPENAI_MODEL;
    delete process.env.OPENROUTER_MODEL;
    const { client, create } = mockOpenAI(JSON.stringify(validPrep()));

    await generateInterviewPrep(client, INPUT);

    expect(create.mock.calls[0][0].model).toBe(DEFAULT_INTERVIEW_PREP_MODEL);
  });

  it("has a stable prompt version, so a stored or logged result stays attributable", () => {
    expect(INTERVIEW_PREP_PROMPT_VERSION).toBe("interview-prep-v1");
  });
});
