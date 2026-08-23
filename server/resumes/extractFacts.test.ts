import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawExtractionResult } from "./openaiExtraction.js";

const extractResumeText = vi.fn();
const runResumeFactExtraction = vi.fn();

class FakeMalformedExtractionError extends Error {}
class FakeUnsupportedResumeFormatError extends Error {}

vi.mock("./textExtraction.js", () => ({
  extractResumeText,
  UnsupportedResumeFormatError: FakeUnsupportedResumeFormatError,
}));

vi.mock("./openaiExtraction.js", () => ({
  runResumeFactExtraction,
  MalformedExtractionError: FakeMalformedExtractionError,
  DEFAULT_OPENAI_MODEL: "test-default-model",
  EXTRACTION_PROMPT_VERSION: "resume-extraction-v1",
}));

const { extractResumeFacts } = await import("./extractFacts.js");

type TableResult = { data: unknown; error: unknown };

function tableBuilder(result: TableResult) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  const builder: Record<string, unknown> & PromiseLike<TableResult> & { calls: typeof calls } = {
    calls,
    select: record("select"),
    insert: record("insert"),
    eq: record("eq"),
    maybeSingle: (...args: unknown[]) => {
      calls.push({ method: "maybeSingle", args });
      return Promise.resolve(result);
    },
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as Record<string, unknown> & PromiseLike<TableResult> & { calls: typeof calls };
  return builder;
}

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_CANDIDATE_ID = "22222222-2222-2222-2222-222222222222";
const RESUME_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function makeServiceClient(options: {
  resumeDocumentsResult?: TableResult;
  extractedFactsInsertResult?: TableResult;
  factConfirmationsInsertResult?: TableResult;
  downloadResult?: { data: unknown; error: unknown };
} = {}) {
  const resumeDocumentsResult: TableResult = options.resumeDocumentsResult ?? {
    data: {
      id: RESUME_ID,
      candidate_id: CANDIDATE_ID,
      storage_path: `${CANDIDATE_ID}/resume.pdf`,
      mime_type: "application/pdf",
    },
    error: null,
  };
  const extractedFactsInsertResult: TableResult = options.extractedFactsInsertResult ?? {
    data: [{ id: "fact-1", fact_type: "full_name", fact_value: "Jordan Rivera" }],
    error: null,
  };
  const factConfirmationsInsertResult: TableResult = options.factConfirmationsInsertResult ?? {
    data: [{}],
    error: null,
  };

  const resultsByTable: Record<string, TableResult> = {
    resume_documents: resumeDocumentsResult,
    extracted_facts: extractedFactsInsertResult,
    fact_confirmations: factConfirmationsInsertResult,
  };

  const builders: Record<string, ReturnType<typeof tableBuilder>> = {};
  const from = vi.fn((table: string) => {
    if (!builders[table]) {
      builders[table] = tableBuilder(resultsByTable[table]);
    }
    return builders[table];
  });

  const download = vi.fn().mockResolvedValue(
    options.downloadResult ?? {
      data: { arrayBuffer: async () => new TextEncoder().encode("fake file bytes").buffer },
      error: null,
    },
  );

  const client = {
    from,
    storage: { from: vi.fn(() => ({ download })) },
  };

  return { client: client as unknown as Parameters<typeof extractResumeFacts>[0], from, builders, download };
}

function validExtraction(overrides: Partial<RawExtractionResult> = {}): RawExtractionResult {
  return {
    full_name: "Jordan Rivera",
    email: null,
    phone: null,
    location: null,
    current_title: null,
    years_of_experience: null,
    most_recent_employer: null,
    skills: [],
    education: [],
    experience: [],
    ...overrides,
  };
}

const fakeOpenAIClient = {} as Parameters<typeof extractResumeFacts>[1];

describe("extractResumeFacts", () => {
  beforeEach(() => {
    extractResumeText.mockReset();
    runResumeFactExtraction.mockReset();
  });

  it("returns not_found when no resume_documents row exists for the id", async () => {
    const { client } = makeServiceClient({ resumeDocumentsResult: { data: null, error: null } });

    const result = await extractResumeFacts(client, fakeOpenAIClient, {
      resumeId: RESUME_ID,
      candidateId: CANDIDATE_ID,
    });

    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns not_found (not forbidden) when the resume belongs to a different candidate", async () => {
    const { client } = makeServiceClient({
      resumeDocumentsResult: {
        data: {
          id: RESUME_ID,
          candidate_id: OTHER_CANDIDATE_ID,
          storage_path: `${OTHER_CANDIDATE_ID}/resume.pdf`,
          mime_type: "application/pdf",
        },
        error: null,
      },
    });

    const result = await extractResumeFacts(client, fakeOpenAIClient, {
      resumeId: RESUME_ID,
      candidateId: CANDIDATE_ID,
    });

    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns error when the resume_documents lookup itself errors", async () => {
    const { client } = makeServiceClient({
      resumeDocumentsResult: { data: null, error: { message: "db down" } },
    });

    const result = await extractResumeFacts(client, fakeOpenAIClient, {
      resumeId: RESUME_ID,
      candidateId: CANDIDATE_ID,
    });

    expect(result.kind).toBe("error");
  });

  it("returns error when the storage download fails", async () => {
    const { client } = makeServiceClient({ downloadResult: { data: null, error: { message: "not found" } } });

    const result = await extractResumeFacts(client, fakeOpenAIClient, {
      resumeId: RESUME_ID,
      candidateId: CANDIDATE_ID,
    });

    expect(result.kind).toBe("error");
  });

  it("returns unsupported_format when text extraction rejects the mime type, and never calls OpenAI", async () => {
    extractResumeText.mockRejectedValueOnce(new FakeUnsupportedResumeFormatError("nope"));
    const { client } = makeServiceClient();

    const result = await extractResumeFacts(client, fakeOpenAIClient, {
      resumeId: RESUME_ID,
      candidateId: CANDIDATE_ID,
    });

    expect(result).toEqual({ kind: "unsupported_format" });
    expect(runResumeFactExtraction).not.toHaveBeenCalled();
  });

  it("returns malformed_extraction and inserts nothing when OpenAI output fails validation", async () => {
    extractResumeText.mockResolvedValueOnce("resume text");
    runResumeFactExtraction.mockRejectedValueOnce(new FakeMalformedExtractionError("bad shape"));
    const { client, from } = makeServiceClient();

    const result = await extractResumeFacts(client, fakeOpenAIClient, {
      resumeId: RESUME_ID,
      candidateId: CANDIDATE_ID,
    });

    expect(result.kind).toBe("malformed_extraction");
    expect(from).not.toHaveBeenCalledWith("extracted_facts");
  });

  it("never guesses: fields the model returned as null produce no fact row at all", async () => {
    extractResumeText.mockResolvedValueOnce("resume text");
    runResumeFactExtraction.mockResolvedValueOnce(validExtraction());
    const { client, builders } = makeServiceClient({
      extractedFactsInsertResult: { data: [{ id: "fact-1", fact_type: "full_name", fact_value: "Jordan Rivera" }], error: null },
    });

    await extractResumeFacts(client, fakeOpenAIClient, { resumeId: RESUME_ID, candidateId: CANDIDATE_ID });

    const insertedRows = builders.extracted_facts.calls.find((call) => call.method === "insert")!
      .args[0] as Array<{ fact_type: string }>;
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].fact_type).toBe("full_name");
  });

  it("skips the insert entirely and returns an empty facts array when nothing was determined", async () => {
    extractResumeText.mockResolvedValueOnce("resume text");
    runResumeFactExtraction.mockResolvedValueOnce(validExtraction({ full_name: null }));
    const { client, from } = makeServiceClient();

    const result = await extractResumeFacts(client, fakeOpenAIClient, {
      resumeId: RESUME_ID,
      candidateId: CANDIDATE_ID,
    });

    expect(result).toEqual({ kind: "success", facts: [] });
    expect(from).not.toHaveBeenCalledWith("extracted_facts");
  });

  it("flattens a repeatable education entry into a single fact_value, skipping entries with every field null", async () => {
    extractResumeText.mockResolvedValueOnce("resume text");
    runResumeFactExtraction.mockResolvedValueOnce(
      validExtraction({
        education: [
          { degree: "B.Tech", institution: "IIT Bombay", year: "2018" },
          { degree: null, institution: null, year: null },
        ],
      }),
    );
    const { client, builders } = makeServiceClient({
      extractedFactsInsertResult: {
        data: [
          { id: "f1", fact_type: "full_name", fact_value: "Jordan Rivera" },
          { id: "f2", fact_type: "education", fact_value: "B.Tech — IIT Bombay (2018)" },
        ],
        error: null,
      },
    });

    await extractResumeFacts(client, fakeOpenAIClient, { resumeId: RESUME_ID, candidateId: CANDIDATE_ID });

    const insertedRows = builders.extracted_facts.calls.find((call) => call.method === "insert")!
      .args[0] as Array<{ fact_type: string; fact_value: string }>;
    const educationRows = insertedRows.filter((row) => row.fact_type === "education");
    expect(educationRows).toEqual([{ fact_type: "education", fact_value: "B.Tech — IIT Bombay (2018)" }].map((r) => expect.objectContaining(r)));
  });

  it("records extraction_model and extraction_prompt_version on every inserted row", async () => {
    extractResumeText.mockResolvedValueOnce("resume text");
    runResumeFactExtraction.mockResolvedValueOnce(validExtraction());
    const { client, builders } = makeServiceClient();

    await extractResumeFacts(
      client,
      fakeOpenAIClient,
      { resumeId: RESUME_ID, candidateId: CANDIDATE_ID },
      "explicit-test-model",
    );

    const insertedRows = builders.extracted_facts.calls.find((call) => call.method === "insert")!
      .args[0] as Array<{ extraction_model: string; extraction_prompt_version: string }>;
    expect(insertedRows[0].extraction_model).toBe("explicit-test-model");
    expect(insertedRows[0].extraction_prompt_version).toBe("resume-extraction-v1");
  });

  it("returns error when the extracted_facts insert itself fails", async () => {
    extractResumeText.mockResolvedValueOnce("resume text");
    runResumeFactExtraction.mockResolvedValueOnce(validExtraction());
    const { client } = makeServiceClient({
      extractedFactsInsertResult: { data: null, error: { message: "insert failed" } },
    });

    const result = await extractResumeFacts(client, fakeOpenAIClient, {
      resumeId: RESUME_ID,
      candidateId: CANDIDATE_ID,
    });

    expect(result.kind).toBe("error");
  });

  it("maps successfully inserted rows to the camelCase result shape", async () => {
    extractResumeText.mockResolvedValueOnce("resume text");
    runResumeFactExtraction.mockResolvedValueOnce(validExtraction());
    const { client } = makeServiceClient({
      extractedFactsInsertResult: {
        data: [{ id: "fact-1", fact_type: "full_name", fact_value: "Jordan Rivera" }],
        error: null,
      },
    });

    const result = await extractResumeFacts(client, fakeOpenAIClient, {
      resumeId: RESUME_ID,
      candidateId: CANDIDATE_ID,
    });

    expect(result).toEqual({
      kind: "success",
      facts: [{ id: "fact-1", factType: "full_name", factValue: "Jordan Rivera" }],
    });
  });

  it("MP-F2: inserts a pending fact_confirmations row for every extracted fact, so Confirm/Correct/Reject never target a missing row", async () => {
    extractResumeText.mockResolvedValueOnce("resume text");
    runResumeFactExtraction.mockResolvedValueOnce(validExtraction());
    const { client, builders } = makeServiceClient({
      extractedFactsInsertResult: {
        data: [{ id: "fact-1", fact_type: "full_name", fact_value: "Jordan Rivera" }],
        error: null,
      },
    });

    await extractResumeFacts(client, fakeOpenAIClient, { resumeId: RESUME_ID, candidateId: CANDIDATE_ID });

    const insertedConfirmations = builders.fact_confirmations.calls.find((call) => call.method === "insert")!
      .args[0] as Array<{ extracted_fact_id: string; status: string }>;
    expect(insertedConfirmations).toEqual([{ extracted_fact_id: "fact-1", status: "pending" }]);
  });

  it("returns error when the fact_confirmations insert fails, even though extracted_facts already committed", async () => {
    extractResumeText.mockResolvedValueOnce("resume text");
    runResumeFactExtraction.mockResolvedValueOnce(validExtraction());
    const { client } = makeServiceClient({
      factConfirmationsInsertResult: { data: null, error: { message: "insert failed" } },
    });

    const result = await extractResumeFacts(client, fakeOpenAIClient, {
      resumeId: RESUME_ID,
      candidateId: CANDIDATE_ID,
    });

    expect(result.kind).toBe("error");
  });

  it("never inserts into fact_confirmations when there are no facts to confirm", async () => {
    extractResumeText.mockResolvedValueOnce("resume text");
    runResumeFactExtraction.mockResolvedValueOnce(validExtraction({ full_name: null }));
    const { client, from } = makeServiceClient();

    await extractResumeFacts(client, fakeOpenAIClient, { resumeId: RESUME_ID, candidateId: CANDIDATE_ID });

    expect(from).not.toHaveBeenCalledWith("fact_confirmations");
  });
});
