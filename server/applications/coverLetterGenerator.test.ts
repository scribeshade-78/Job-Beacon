import { describe, expect, it, vi } from "vitest";
import {
  allCoverLetterClaims,
  COVER_LETTER_PROMPT_VERSION,
  COVER_LETTER_SYSTEM_PROMPT,
  generateCoverLetter,
  MalformedCoverLetterError,
  MAX_COVER_LETTER_PARAGRAPHS,
  MAX_PARAGRAPH_CHARS,
} from "./coverLetterGenerator.js";
import {
  FabricatedContentError,
  NoConfirmedFactsError,
  UncitedClaimError,
} from "./resumeGenerator.js";

type TableResult = { data: unknown; error: unknown };

const CONFIRMED_FACTS = [
  { id: "fact-1", fact_type: "current_title", fact_value: "Senior Data Engineer" },
  { id: "fact-2", fact_type: "skill", fact_value: "Apache Spark" },
  { id: "fact-3", fact_type: "years_of_experience", fact_value: "7" },
];

function makeQueryBuilder(result: TableResult) {
  const builder: PromiseLike<TableResult> & Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => result,
    single: async () => result,
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as PromiseLike<TableResult> & Record<string, unknown>;
  return builder;
}

function makeClient(overrides: Partial<Record<string, TableResult>> = {}) {
  const defaults: Record<string, TableResult> = {
    extracted_facts: { data: CONFIRMED_FACTS, error: null },
    fact_confirmations: {
      data: CONFIRMED_FACTS.map((fact) => ({ extracted_fact_id: fact.id, corrected_value: null })),
      error: null,
    },
    vacancies: { data: { raw_title: "Staff Data Engineer" }, error: null },
    vacancy_jd_snapshots: { data: { clean_text: "We need Spark experience." }, error: null },
  };
  const results = { ...defaults, ...overrides };
  const from = vi.fn((table: string) => {
    const result = results[table];
    if (!result) throw new Error(`Unexpected table: ${table}`);
    return makeQueryBuilder(result);
  });
  return { from } as never;
}

/** A fully grounded letter: every paragraph cites a real confirmed fact. */
const VALID_RESPONSE = {
  paragraphs: [
    { text: "I am a Senior Data Engineer with seven years of experience.", factRefs: ["fact-1", "fact-3"] },
    { text: "Most of that work has been in Apache Spark.", factRefs: ["fact-2"] },
    { text: "I would welcome the chance to discuss the role.", factRefs: ["fact-1"] },
  ],
};

/** The subset of the chat-completions request these tests assert on. */
interface ChatCall {
  messages: Array<{ role: string; content: string }>;
}

function makeModel(response: unknown) {
  const create = vi.fn(async (_body: ChatCall) => ({
    choices: [{ message: { content: typeof response === "string" ? response : JSON.stringify(response) } }],
  }));
  return { openai: { chat: { completions: { create } } } as never, create };
}

/** The user message of the first (and only) model call. */
function userMessageOf(create: ReturnType<typeof makeModel>["create"]): string {
  return create.mock.calls[0]?.[0]?.messages.find((message) => message.role === "user")?.content ?? "";
}

const input = { candidateId: "cand-1", vacancyId: "vac-1" };

describe("the cover letter prompt", () => {
  it("asks for at most three paragraphs", () => {
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain("at most three short paragraphs");
  });

  it("forbids invention explicitly, and names what counts as invention", () => {
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain("only source of truth");
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain("MUST NOT");
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain("extractedFactIds");
  });

  it("forbids inventing feelings about the company, which a cover letter invites", () => {
    // The model is given facts about the candidate, never about their opinion
    // of the employer. "I have always admired..." is the classic fabrication
    // in this genre and it is not something the facts can support.
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain("enthusiasm");
  });

  it("forbids addressing a named person, since no name is ever provided", () => {
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain("Do not address a named person");
  });
});

describe("generateCoverLetter — the happy path", () => {
  it("returns the letter, its citations, and its versions", async () => {
    const client = makeClient();
    const model = makeModel(VALID_RESPONSE);

    const result = await generateCoverLetter(client, { openai: model.openai }, { ...input, model: "test/model-v1" });

    expect(result.paragraphs).toHaveLength(3);
    expect(result.citedFactCount).toBe(3);
    expect(result.modelVersion).toBe("test/model-v1");
    expect(result.promptVersion).toBe(COVER_LETTER_PROMPT_VERSION);
  });

  it("joins the paragraphs into the text that would be stored", async () => {
    const client = makeClient();

    const result = await generateCoverLetter(client, { openai: makeModel(VALID_RESPONSE).openai }, input);

    expect(result.text).toBe(VALID_RESPONSE.paragraphs.map((p) => p.text).join("\n\n"));
    expect(result.text).not.toContain("factRefs");
  });

  it("hands the model the confirmed facts with their ids, and the posting text", async () => {
    const client = makeClient();
    const model = makeModel(VALID_RESPONSE);

    await generateCoverLetter(client, { openai: model.openai }, input);

    const body = userMessageOf(model.create);
    expect(body).toContain("[fact-1] (current_title) Senior Data Engineer");
    expect(body).toContain("[fact-3] (years_of_experience) 7");
    expect(body).toContain("Staff Data Engineer");
    expect(body).toContain("We need Spark experience.");
  });

  it("says the posting has no description rather than implying it had one", async () => {
    const client = makeClient({ vacancy_jd_snapshots: { data: null, error: null } });
    const model = makeModel(VALID_RESPONSE);

    await generateCoverLetter(client, { openai: model.openai }, input);

    expect(userMessageOf(model.create)).toContain("Description: none available");
  });

  it("drops empty paragraphs instead of storing blank ones", async () => {
    const client = makeClient();
    const model = makeModel({
      paragraphs: [
        VALID_RESPONSE.paragraphs[0],
        { text: "   ", factRefs: [] },
        VALID_RESPONSE.paragraphs[1],
      ],
    });

    const result = await generateCoverLetter(client, { openai: model.openai }, input);

    expect(result.paragraphs).toHaveLength(2);
    expect(result.text).not.toContain("\n\n\n");
  });
});

describe("generateCoverLetter — the honesty gate", () => {
  it("throws UncitedClaimError when a paragraph cites nothing", async () => {
    // The headline failure this whole phase exists to prevent: prose about the
    // candidate that no confirmed fact supports.
    const client = makeClient();
    const model = makeModel({
      paragraphs: [
        VALID_RESPONSE.paragraphs[0],
        { text: "I have led teams of twenty engineers across three continents.", factRefs: [] },
      ],
    });

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      UncitedClaimError,
    );
  });

  it("does not report a refused cover letter as a resume", async () => {
    // UncitedClaimError is raised by the shared gate for both artifacts, so its
    // wording must not name one of them. It previously said "Tailored resume",
    // which sent a reader of a failed cover letter to the wrong generator.
    const client = makeClient();
    const model = makeModel({ paragraphs: [{ text: "An uncited claim.", factRefs: [] }] });

    const error = await generateCoverLetter(client, { openai: model.openai }, input).catch((e: unknown) => e);

    expect((error as Error).message).not.toContain("resume");
    expect((error as Error).message).toContain("no cited confirmed fact");
  });

  it("tells the model the closing is optional and why, since an uncitable one is refused", () => {
    // The v2 prompt asked for a closing and the gate then rejected the one the
    // model wrote, so the instruction and the enforcement disagreed.
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain("Optionally, a third paragraph");
    expect(COVER_LETTER_SYSTEM_PROMPT).toContain("write two paragraphs instead");
  });

  it("names the uncited paragraph on the error, so the failure is actionable", async () => {
    const client = makeClient();
    const model = makeModel({
      paragraphs: [{ text: "I am fluent in Kubernetes and Rust.", factRefs: [] }],
    });

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toMatchObject({
      uncitedTexts: ["I am fluent in Kubernetes and Rust."],
    });
  });

  it("throws FabricatedContentError when a paragraph cites a fact that does not exist", async () => {
    // Fabrication wearing the costume of evidence: the citation is present, so
    // the uncited check passes and only the id check catches it.
    const client = makeClient();
    const model = makeModel({
      paragraphs: [{ text: "I hold a PhD in distributed systems.", factRefs: ["fact-does-not-exist"] }],
    });

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      FabricatedContentError,
    );
  });

  it("catches an invented skill in an otherwise well-cited letter", async () => {
    const client = makeClient();
    const model = makeModel({
      paragraphs: [
        VALID_RESPONSE.paragraphs[0],
        { text: "I also bring deep Kubernetes experience.", factRefs: ["fact-ghost"] },
      ],
    });

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toMatchObject({
      unknownFactRefs: ["fact-ghost"],
    });
  });

  it("refuses the whole letter rather than dropping the offending paragraph", async () => {
    // A letter is sent as one document. Keeping the good paragraphs would send
    // something the gate never approved as a whole.
    const client = makeClient();
    const model = makeModel({
      paragraphs: [
        VALID_RESPONSE.paragraphs[0],
        { text: "Unsupported claim here.", factRefs: [] },
        VALID_RESPONSE.paragraphs[1],
      ],
    });

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      UncitedClaimError,
    );
  });

  it("runs the gate BEFORE the empty-letter check, so fabrication is reported as fabrication", async () => {
    const client = makeClient();
    const model = makeModel({
      paragraphs: [{ text: "An invented claim.", factRefs: ["nope"] }],
    });

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      FabricatedContentError,
    );
  });

  it("uses the same gate the resume generator uses, not a second copy of it", async () => {
    // Both call verifyGroundedClaims. This pins the shared identity: if the
    // cover letter ever grows its own check, the error classes would drift and
    // callers handling one would stop handling the other.
    const claims = allCoverLetterClaims({ paragraphs: [{ text: "x", factRefs: [] }] });
    expect(claims).toHaveLength(1);

    const client = makeClient();
    const model = makeModel({ paragraphs: [{ text: "x", factRefs: [] }] });

    const error = await generateCoverLetter(client, { openai: model.openai }, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UncitedClaimError);
    expect((error as Error).name).toBe("UncitedClaimError");
  });
});

describe("generateCoverLetter — refusals that are not the honesty gate", () => {
  it("throws NoConfirmedFactsError when there is nothing to cite at all", async () => {
    const client = makeClient({ extracted_facts: { data: [], error: null } });
    const model = makeModel(VALID_RESPONSE);

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      NoConfirmedFactsError,
    );
    // No model call is made for a candidate who cannot be written about.
    expect(model.create).not.toHaveBeenCalled();
  });

  it("refuses a fourth paragraph rather than trimming it", async () => {
    const client = makeClient();
    const model = makeModel({
      paragraphs: Array.from({ length: MAX_COVER_LETTER_PARAGRAPHS + 1 }, () => VALID_RESPONSE.paragraphs[0]),
    });

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toThrow(
      /at most 3 paragraphs/,
    );
  });

  it("refuses an over-long paragraph rather than cutting it mid-sentence", async () => {
    const client = makeClient();
    const model = makeModel({
      paragraphs: [{ text: "x".repeat(MAX_PARAGRAPH_CHARS + 1), factRefs: ["fact-1"] }],
    });

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toThrow(
      /character ceiling/,
    );
  });

  it("throws on non-JSON output", async () => {
    const client = makeClient();
    const model = makeModel("Certainly! Here is your cover letter:");

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      MalformedCoverLetterError,
    );
  });

  it("throws when the JSON is valid but the shape is wrong", async () => {
    const client = makeClient();
    const model = makeModel({ letter: "Dear Sir/Madam..." });

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      MalformedCoverLetterError,
    );
  });

  it("throws when a paragraph is a bare string instead of a grounded claim", async () => {
    const client = makeClient();
    const model = makeModel({ paragraphs: ["I am a Senior Data Engineer."] });

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      MalformedCoverLetterError,
    );
  });

  it("throws when every paragraph came back empty", async () => {
    const client = makeClient();
    const model = makeModel({ paragraphs: [{ text: "  ", factRefs: [] }] });

    await expect(generateCoverLetter(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      MalformedCoverLetterError,
    );
  });

  it("throws when the model returns empty content", async () => {
    const client = makeClient();
    const create = vi.fn(async () => ({ choices: [{ message: { content: "" } }] }));

    await expect(
      generateCoverLetter(client, { openai: { chat: { completions: { create } } } as never }, input),
    ).rejects.toBeInstanceOf(MalformedCoverLetterError);
  });

  it("propagates a model failure rather than returning a partial letter", async () => {
    const client = makeClient();
    const create = vi.fn(async () => {
      throw new Error("openrouter unreachable");
    });

    await expect(
      generateCoverLetter(client, { openai: { chat: { completions: { create } } } as never }, input),
    ).rejects.toThrow(/openrouter unreachable/);
  });
});
