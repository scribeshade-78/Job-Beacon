import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";

const classifyMessageContent = vi.fn();

class FakeMalformedClassificationError extends Error {}

vi.mock("./classifyMessage.js", () => ({
  classifyMessageContent,
  MalformedClassificationError: FakeMalformedClassificationError,
  DEFAULT_CLASSIFICATION_MODEL: "test-default-model",
  MESSAGE_CLASSIFICATION_PROMPT_VERSION: "message-classification-v1",
}));

const { classifyAndStoreMessage, runMessageClassificationBatch } = await import("./classifyBatch.js");

const fakeOpenAIClient = {} as Pick<OpenAI, "chat">;

function validClassification(overrides: Record<string, unknown> = {}) {
  return {
    category: "interview",
    confidence: 0.9,
    company: "Acme Corp",
    role: "Backend Engineer",
    job_id: "REQ-1",
    deadline: "2026-09-01",
    salary_text: "18 LPA",
    ...overrides,
  };
}

function makeClient(
  opts: {
    messagesResult?: { data: unknown; error: unknown };
    upsertResult?: { error: unknown };
  } = {},
) {
  const upsert = vi.fn(async (_row: unknown, _options: unknown) => opts.upsertResult ?? { error: null });
  const limit = vi.fn(async () => opts.messagesResult ?? { data: [], error: null });
  const order = vi.fn(() => ({ limit }));
  const is = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ is }));
  const from = vi.fn((table: string) => {
    if (table === "messages") return { select };
    if (table === "response_classifications") return { upsert };
    throw new Error(`unexpected table ${table}`);
  });
  return { client: { from } as unknown as SupabaseClient, from, upsert, select, is, order, limit };
}

beforeEach(() => {
  classifyMessageContent.mockReset();
});

describe("classifyAndStoreMessage", () => {
  const message = { messageId: "msg-1", sender: "r@acme.test", subject: "Hi", bodyText: "body" };

  it("maps the classification onto a response_classifications upsert keyed on message_id", async () => {
    classifyMessageContent.mockResolvedValueOnce(validClassification());
    const { client, upsert } = makeClient();

    const result = await classifyAndStoreMessage(client, fakeOpenAIClient, message, "explicit-model");

    expect(result).toEqual({ kind: "classified", category: "interview" });
    expect(upsert).toHaveBeenCalledWith(
      {
        message_id: "msg-1",
        category: "interview",
        confidence: 0.9,
        model_version: "explicit-model",
        prompt_version: "message-classification-v1",
        extracted_company: "Acme Corp",
        extracted_role: "Backend Engineer",
        extracted_job_id: "REQ-1",
        extracted_deadline: "2026-09-01",
        extracted_salary_text: "18 LPA",
        raw_extraction: validClassification(),
      },
      { onConflict: "message_id" },
    );
  });

  it("falls back to the default model for model_version when none is passed", async () => {
    classifyMessageContent.mockResolvedValueOnce(validClassification());
    const { client, upsert } = makeClient();

    await classifyAndStoreMessage(client, fakeOpenAIClient, message);

    expect(upsert.mock.calls[0][0]).toMatchObject({ model_version: "test-default-model" });
    expect(classifyMessageContent).toHaveBeenCalledWith(fakeOpenAIClient, expect.anything(), "test-default-model");
  });

  it("returns malformed and writes nothing when the model output is rejected", async () => {
    classifyMessageContent.mockRejectedValueOnce(new FakeMalformedClassificationError("bad shape"));
    const { client, from } = makeClient();

    const result = await classifyAndStoreMessage(client, fakeOpenAIClient, message);

    expect(result.kind).toBe("malformed");
    expect(from).not.toHaveBeenCalledWith("response_classifications");
  });

  it("returns error and writes nothing on a non-malformed classification failure", async () => {
    classifyMessageContent.mockRejectedValueOnce(new Error("OpenRouter 503"));
    const { client, from } = makeClient();

    const result = await classifyAndStoreMessage(client, fakeOpenAIClient, message);

    expect(result).toEqual({ kind: "error", message: "OpenRouter 503" });
    expect(from).not.toHaveBeenCalledWith("response_classifications");
  });

  it("returns error when the upsert itself fails", async () => {
    classifyMessageContent.mockResolvedValueOnce(validClassification());
    const { client } = makeClient({ upsertResult: { error: { message: "unique violation" } } });

    const result = await classifyAndStoreMessage(client, fakeOpenAIClient, message);

    expect(result).toEqual({ kind: "error", message: "unique violation" });
  });

  it("never throws — a rejected classification becomes a result value", async () => {
    classifyMessageContent.mockRejectedValueOnce(new Error("boom"));
    const { client } = makeClient();

    await expect(classifyAndStoreMessage(client, fakeOpenAIClient, message)).resolves.toBeDefined();
  });
});

describe("runMessageClassificationBatch", () => {
  it("returns all-zero and does not classify when no messages are unclassified", async () => {
    const { client } = makeClient({ messagesResult: { data: [], error: null } });

    const result = await runMessageClassificationBatch(client, fakeOpenAIClient);

    expect(result).toEqual({ scanned: 0, classified: 0, malformed: 0, errors: 0 });
    expect(classifyMessageContent).not.toHaveBeenCalled();
  });

  it("throws when the unclassified-messages query errors", async () => {
    const { client } = makeClient({ messagesResult: { data: null, error: new Error("db down") } });

    await expect(runMessageClassificationBatch(client, fakeOpenAIClient)).rejects.toThrow("db down");
  });

  it("classifies each row from its stored snippet and tallies outcomes", async () => {
    const { client } = makeClient({
      messagesResult: {
        data: [
          { id: "m1", sender: "a@x.test", subject: "S1", raw_payload: { snippet: "you are invited" } },
          { id: "m2", sender: "b@x.test", subject: "S2", raw_payload: { snippet: "unfortunately" } },
          { id: "m3", sender: "c@x.test", subject: "S3", raw_payload: { snippet: "garbled" } },
        ],
        error: null,
      },
    });
    classifyMessageContent
      .mockResolvedValueOnce(validClassification({ category: "interview" }))
      .mockRejectedValueOnce(new FakeMalformedClassificationError("bad"))
      .mockRejectedValueOnce(new Error("timeout"));

    const result = await runMessageClassificationBatch(client, fakeOpenAIClient);

    expect(result).toEqual({ scanned: 3, classified: 1, malformed: 1, errors: 1 });
    expect(classifyMessageContent.mock.calls[0][1]).toEqual({
      sender: "a@x.test",
      subject: "S1",
      bodyText: "you are invited",
    });
  });

  it("passes bodyText: null when a message row has no usable snippet", async () => {
    const { client } = makeClient({
      messagesResult: {
        data: [{ id: "m1", sender: null, subject: "S", raw_payload: null }],
        error: null,
      },
    });
    classifyMessageContent.mockResolvedValueOnce(validClassification({ category: "other" }));

    await runMessageClassificationBatch(client, fakeOpenAIClient);

    expect(classifyMessageContent.mock.calls[0][1]).toEqual({ sender: null, subject: "S", bodyText: null });
  });

  it("defaults the batch limit to 25 and forwards an explicit limit", async () => {
    const a = makeClient();
    await runMessageClassificationBatch(a.client, fakeOpenAIClient);
    expect(a.limit).toHaveBeenCalledWith(25);

    const b = makeClient();
    await runMessageClassificationBatch(b.client, fakeOpenAIClient, { limit: 5 });
    expect(b.limit).toHaveBeenCalledWith(5);
  });
});
