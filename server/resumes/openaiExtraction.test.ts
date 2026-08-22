import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import {
  isValidRawExtractionResult,
  MalformedExtractionError,
  runResumeFactExtraction,
  type RawExtractionResult,
} from "./openaiExtraction.js";

function validResult(overrides: Partial<RawExtractionResult> = {}): RawExtractionResult {
  return {
    full_name: "Jordan Rivera",
    email: "jordan@example.com",
    phone: null,
    location: "Bengaluru",
    current_title: "Backend Engineer",
    years_of_experience: 5,
    most_recent_employer: "Acme Corp",
    skills: ["TypeScript", "Postgres"],
    education: [{ degree: "B.Tech", institution: "IIT Bombay", year: "2018" }],
    experience: [{ title: "Backend Engineer", company: "Acme Corp", duration: "2020-2024" }],
    ...overrides,
  };
}

function makeOpenAIClient(content: string | null) {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content } }],
  });
  return { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">;
}

describe("isValidRawExtractionResult", () => {
  it("accepts a fully valid result", () => {
    expect(isValidRawExtractionResult(validResult())).toBe(true);
  });

  it("accepts null scalar fields (the honest 'could not determine' state)", () => {
    expect(
      isValidRawExtractionResult(
        validResult({ full_name: null, email: null, phone: null, years_of_experience: null }),
      ),
    ).toBe(true);
  });

  it("accepts empty repeatable arrays", () => {
    expect(isValidRawExtractionResult(validResult({ skills: [], education: [], experience: [] }))).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(isValidRawExtractionResult("not an object")).toBe(false);
    expect(isValidRawExtractionResult(null)).toBe(false);
    expect(isValidRawExtractionResult([])).toBe(false);
  });

  it("rejects a missing required key", () => {
    const { full_name: _full_name, ...withoutFullName } = validResult();
    expect(isValidRawExtractionResult(withoutFullName)).toBe(false);
  });

  it("rejects an unexpected extra key", () => {
    expect(isValidRawExtractionResult({ ...validResult(), extra_field: "surprise" })).toBe(false);
  });

  it("rejects a scalar field with the wrong type", () => {
    expect(isValidRawExtractionResult(validResult({ full_name: 123 as unknown as string }))).toBe(false);
  });

  it("rejects years_of_experience as a string", () => {
    expect(isValidRawExtractionResult(validResult({ years_of_experience: "5" as unknown as number }))).toBe(false);
  });

  it("rejects a skills array containing a non-string", () => {
    expect(isValidRawExtractionResult(validResult({ skills: ["ok", 42 as unknown as string] }))).toBe(false);
  });

  it("rejects an education entry missing a field", () => {
    expect(
      isValidRawExtractionResult(
        validResult({ education: [{ degree: "B.Tech", institution: "IIT Bombay" } as never] }),
      ),
    ).toBe(false);
  });

  it("rejects an experience entry with an extra field", () => {
    expect(
      isValidRawExtractionResult(
        validResult({
          experience: [{ title: "Eng", company: "Acme", duration: "1y", extra: "x" } as never],
        }),
      ),
    ).toBe(false);
  });
});

describe("runResumeFactExtraction", () => {
  it("returns the parsed result on a valid structured-output response", async () => {
    const result = validResult();
    const client = makeOpenAIClient(JSON.stringify(result));

    const extracted = await runResumeFactExtraction(client, "resume text", "test-model");

    expect(extracted).toEqual(result);
    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "test-model" }),
    );
  });

  it("throws MalformedExtractionError when content is empty", async () => {
    const client = makeOpenAIClient(null);

    await expect(runResumeFactExtraction(client, "resume text", "test-model")).rejects.toBeInstanceOf(
      MalformedExtractionError,
    );
  });

  it("throws MalformedExtractionError when content is not valid JSON", async () => {
    const client = makeOpenAIClient("not json");

    await expect(runResumeFactExtraction(client, "resume text", "test-model")).rejects.toBeInstanceOf(
      MalformedExtractionError,
    );
  });

  it("throws MalformedExtractionError when content is valid JSON but fails schema validation", async () => {
    const client = makeOpenAIClient(JSON.stringify({ not: "the expected shape" }));

    await expect(runResumeFactExtraction(client, "resume text", "test-model")).rejects.toBeInstanceOf(
      MalformedExtractionError,
    );
  });
});
