import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import {
  classifyMessageContent,
  isValidRawMessageClassification,
  MalformedClassificationError,
  type RawMessageClassification,
} from "./classifyMessage.js";

function validClassification(overrides: Partial<RawMessageClassification> = {}): RawMessageClassification {
  return {
    category: "interview",
    confidence: 0.9,
    company: "Acme Corp",
    role: "Backend Engineer",
    job_id: "REQ-123",
    deadline: "2026-09-01",
    salary_text: "18-24 LPA",
    ...overrides,
  };
}

function makeOpenAIClient(content: string | null) {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content } }] });
  return { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">;
}

describe("isValidRawMessageClassification", () => {
  it("accepts a fully valid result", () => {
    expect(isValidRawMessageClassification(validClassification())).toBe(true);
  });

  it("accepts null entity fields and null confidence", () => {
    expect(
      isValidRawMessageClassification(
        validClassification({ confidence: null, company: null, role: null, job_id: null, deadline: null, salary_text: null }),
      ),
    ).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(isValidRawMessageClassification(null)).toBe(false);
    expect(isValidRawMessageClassification([])).toBe(false);
    expect(isValidRawMessageClassification("interview")).toBe(false);
  });

  it("rejects a category outside the approved vocabulary", () => {
    expect(isValidRawMessageClassification(validClassification({ category: "spam" as never }))).toBe(false);
  });

  it("rejects a missing required key", () => {
    const { salary_text: _omit, ...withoutSalary } = validClassification();
    expect(isValidRawMessageClassification(withoutSalary)).toBe(false);
  });

  it("rejects an unexpected extra key", () => {
    expect(isValidRawMessageClassification({ ...validClassification(), sentiment: "positive" })).toBe(false);
  });

  it("rejects confidence outside 0..1", () => {
    expect(isValidRawMessageClassification(validClassification({ confidence: 1.5 }))).toBe(false);
    expect(isValidRawMessageClassification(validClassification({ confidence: -0.1 }))).toBe(false);
  });

  it("rejects confidence given as a string", () => {
    expect(isValidRawMessageClassification(validClassification({ confidence: "0.9" as unknown as number }))).toBe(false);
  });

  it("rejects a deadline that is not a YYYY-MM-DD date", () => {
    expect(isValidRawMessageClassification(validClassification({ deadline: "next Friday" }))).toBe(false);
    expect(isValidRawMessageClassification(validClassification({ deadline: "2026-09-01T10:00:00Z" }))).toBe(false);
  });

  it("rejects a non-string entity field", () => {
    expect(isValidRawMessageClassification(validClassification({ company: 42 as unknown as string }))).toBe(false);
  });
});

describe("classifyMessageContent", () => {
  it("returns the parsed classification on a valid structured-output response", async () => {
    const result = validClassification();
    const client = makeOpenAIClient(JSON.stringify(result));

    const classification = await classifyMessageContent(
      client,
      { sender: "recruiter@acme.test", subject: "Interview invite", bodyText: "Are you free Tuesday?" },
      "test-model",
    );

    expect(classification).toEqual(result);
    expect(client.chat.completions.create).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
  });

  it("passes sender/subject and a body-unavailable marker when bodyText is null", async () => {
    const client = makeOpenAIClient(JSON.stringify(validClassification({ category: "other" })));

    await classifyMessageContent(client, { sender: "x@y.test", subject: "Hi", bodyText: null }, "test-model");

    const userMessage = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[1]
      .content as string;
    expect(userMessage).toContain("x@y.test");
    expect(userMessage).toContain("body unavailable");
  });

  it("throws MalformedClassificationError when content is empty", async () => {
    await expect(
      classifyMessageContent(makeOpenAIClient(null), { sender: null, subject: null, bodyText: null }, "m"),
    ).rejects.toBeInstanceOf(MalformedClassificationError);
  });

  it("throws MalformedClassificationError when content is not valid JSON", async () => {
    await expect(
      classifyMessageContent(makeOpenAIClient("not json"), { sender: null, subject: null, bodyText: null }, "m"),
    ).rejects.toBeInstanceOf(MalformedClassificationError);
  });

  it("throws MalformedClassificationError when the JSON fails schema validation", async () => {
    await expect(
      classifyMessageContent(
        makeOpenAIClient(JSON.stringify({ category: "not-a-real-category" })),
        { sender: null, subject: null, bodyText: null },
        "m",
      ),
    ).rejects.toBeInstanceOf(MalformedClassificationError);
  });
});
