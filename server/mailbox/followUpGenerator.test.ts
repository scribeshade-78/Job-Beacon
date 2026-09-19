import { describe, expect, it, vi } from "vitest";
import {
  applicationFactId,
  applicationFactIds,
  ApplicationFactsUnavailableError,
  FOLLOW_UP_PROMPT_VERSION,
  FOLLOW_UP_SYSTEM_PROMPT,
  generateFollowUpDraft,
  MalformedFollowUpError,
  MAX_FOLLOW_UP_PARAGRAPHS,
  renderApplicationFacts,
} from "./followUpGenerator.js";
import {
  FabricatedContentError,
  NoConfirmedFactsError,
  UncitedClaimError,
} from "../applications/resumeGenerator.js";

type TableResult = { data: unknown; error: unknown };

const CONFIRMED_FACTS = [
  { id: "fact-1", fact_type: "current_title", fact_value: "Senior Data Engineer" },
  { id: "fact-2", fact_type: "full_name", fact_value: "Sravani Kolapalli" },
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
    vacancies: { data: { raw_title: "Data Engineer III", companies: { displayed_name: "Acme" } }, error: null },
  };
  const results = { ...defaults, ...overrides };
  const from = vi.fn((table: string) => {
    const result = results[table];
    if (!result) throw new Error(`Unexpected table: ${table}`);
    return makeQueryBuilder(result);
  });
  return { from } as never;
}

const input = {
  candidateId: "cand-1",
  vacancyId: "vac-1",
  submittedAt: "2026-08-29T10:00:00.000Z",
  daysSinceSubmission: 20,
};

/**
 * A grounded follow-up. Paragraph 1 cites the APPLICATION facts (which is what
 * makes this generator different from the other two), paragraph 2 cites the
 * candidate's own confirmed facts.
 */
const VALID_RESPONSE = {
  paragraphs: [
    {
      text: "I applied for the Data Engineer III role at Acme on 2026-08-29 and wanted to follow up.",
      factRefs: [applicationFactId("vacancy_title"), applicationFactId("company"), applicationFactId("submitted_on")],
    },
    {
      text: "I remain a Senior Data Engineer and would welcome an update on where things stand.",
      factRefs: ["fact-1", applicationFactId("no_reply_received")],
    },
  ],
};

interface ChatCall {
  messages: Array<{ role: string; content: string }>;
}

function makeModel(response: unknown) {
  const create = vi.fn(async (_body: ChatCall) => ({
    choices: [{ message: { content: typeof response === "string" ? response : JSON.stringify(response) } }],
  }));
  return { openai: { chat: { completions: { create } } } as never, create };
}

function userMessageOf(create: ReturnType<typeof makeModel>["create"]): string {
  return create.mock.calls[0]?.[0]?.messages.find((message) => message.role === "user")?.content ?? "";
}

describe("the follow-up prompt", () => {
  it("asks for exactly two paragraphs", () => {
    expect(FOLLOW_UP_SYSTEM_PROMPT).toContain("exactly two short paragraphs");
  });

  it("forbids re-pitching the candidate, which is the natural failure of this genre", () => {
    // A follow-up that restates the candidate's strengths is a second cover
    // letter, and it reads as pressure rather than a check-in.
    expect(FOLLOW_UP_SYSTEM_PROMPT).toContain("Do not re-pitch the candidate");
  });

  it("forbids expressing emotion about the delay", () => {
    expect(FOLLOW_UP_SYSTEM_PROMPT).toContain("Do not express disappointment");
  });

  it("names both permitted fact sets, so the model knows the application facts are citable", () => {
    expect(FOLLOW_UP_SYSTEM_PROMPT).toContain("CONFIRMED FACTS");
    expect(FOLLOW_UP_SYSTEM_PROMPT).toContain("APPLICATION FACTS");
  });

  it("forbids inventing a reason for the delay", () => {
    expect(FOLLOW_UP_SYSTEM_PROMPT).toContain("Do not invent a reason for the delay");
  });
});

describe("application facts", () => {
  it("renders each fact as a citable line", () => {
    const lines = renderApplicationFacts({
      vacancyTitle: "Data Engineer III",
      companyName: "Acme",
      submittedAt: "2026-08-29T10:00:00.000Z",
      daysSinceSubmission: 20,
    });

    expect(lines.some((line) => line.includes(`[${applicationFactId("vacancy_title")}]`))).toBe(true);
    expect(lines.some((line) => line.includes("Data Engineer III"))).toBe(true);
    expect(lines.some((line) => line.includes("2026-08-29"))).toBe(true);
    expect(lines.some((line) => line.includes("20"))).toBe(true);
  });

  it("omits the company line entirely when there is no company, rather than emitting an empty one", () => {
    const facts = { vacancyTitle: "X", companyName: null, submittedAt: "2026-08-29T00:00:00.000Z", daysSinceSubmission: 9 };

    expect(renderApplicationFacts(facts).some((line) => line.includes("company"))).toBe(false);
    expect(applicationFactIds(facts)).not.toContain(applicationFactId("company"));
  });

  it("keeps the permitted ids and the rendered lines in step", () => {
    // If these two ever disagree, the model is asked to cite an id it was never
    // shown, or shown an id it is not permitted to cite.
    const facts = {
      vacancyTitle: "Data Engineer III",
      companyName: "Acme",
      submittedAt: "2026-08-29T00:00:00.000Z",
      daysSinceSubmission: 20,
    };

    const rendered = renderApplicationFacts(facts).map((line) => line.match(/\[([^\]]+)\]/)?.[1]);

    expect(rendered).toEqual(applicationFactIds(facts));
  });
});

describe("generateFollowUpDraft — the happy path", () => {
  it("returns the draft, its citations and its provenance", async () => {
    const client = makeClient();
    const model = makeModel(VALID_RESPONSE);

    const draft = await generateFollowUpDraft(client, { openai: model.openai }, { ...input, model: "test/model-v1" });

    expect(draft.paragraphs).toHaveLength(2);
    expect(draft.promptVersion).toBe(FOLLOW_UP_PROMPT_VERSION);
    expect(draft.modelVersion).toBe("test/model-v1");
    expect(draft.citedFactCount).toBe(5);
  });

  it("joins the paragraphs into the text that would be sent", async () => {
    const client = makeClient();

    const draft = await generateFollowUpDraft(client, { openai: makeModel(VALID_RESPONSE).openai }, input);

    expect(draft.text).toBe(VALID_RESPONSE.paragraphs.map((p) => p.text).join("\n\n"));
    expect(draft.text).not.toContain("factRefs");
  });

  it("hands the model the application facts alongside the candidate facts", async () => {
    const client = makeClient();
    const model = makeModel(VALID_RESPONSE);

    await generateFollowUpDraft(client, { openai: model.openai }, input);

    const body = userMessageOf(model.create);
    expect(body).toContain("Data Engineer III");
    expect(body).toContain("Acme");
    expect(body).toContain("[fact-1] (current_title) Senior Data Engineer");
    expect(body).toContain(`[${applicationFactId("submitted_on")}]`);
  });

  it("records the application facts it wrote from, so the draft can be checked later", async () => {
    const client = makeClient();

    const draft = await generateFollowUpDraft(client, { openai: makeModel(VALID_RESPONSE).openai }, input);

    expect(draft.metadata.applicationFacts).toMatchObject({
      vacancyTitle: "Data Engineer III",
      companyName: "Acme",
      daysSinceSubmission: 20,
    });
    expect(draft.metadata.citations).toEqual([
      { paragraphIndex: 0, factRefs: VALID_RESPONSE.paragraphs[0]!.factRefs },
      { paragraphIndex: 1, factRefs: VALID_RESPONSE.paragraphs[1]!.factRefs },
    ]);
  });
});

describe("generateFollowUpDraft — the honesty gate", () => {
  it("throws UncitedClaimError for a paragraph that cites nothing", async () => {
    const client = makeClient();
    const model = makeModel({
      paragraphs: [
        VALID_RESPONSE.paragraphs[0],
        { text: "I would also bring deep Kubernetes expertise to your team.", factRefs: [] },
      ],
    });

    await expect(generateFollowUpDraft(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      UncitedClaimError,
    );
  });

  it("throws FabricatedContentError for a citation that does not exist", async () => {
    const client = makeClient();
    const model = makeModel({
      paragraphs: [{ text: "Checking in on my application.", factRefs: ["fact-invented"] }],
    });

    await expect(generateFollowUpDraft(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      FabricatedContentError,
    );
  });

  it("refuses a citation to an application fact that was not supplied", async () => {
    // The application id namespace is ours, so a model that invents one — or
    // cites, say, a salary we never gave it — must be caught the same way an
    // invented extractedFactId is.
    const client = makeClient();
    const model = makeModel({
      paragraphs: [{ text: "Following up on my application.", factRefs: [applicationFactId("salary")] }],
    });

    await expect(generateFollowUpDraft(client, { openai: model.openai }, input)).rejects.toMatchObject({
      unknownFactRefs: [applicationFactId("salary")],
    });
  });

  it("does not accept an application fact that exists but was withheld", async () => {
    // company is omitted from the permitted set when the vacancy has none, so
    // citing it must fail rather than silently pass.
    const client = makeClient({
      vacancies: { data: { raw_title: "Data Engineer III", companies: null }, error: null },
    });
    const model = makeModel({
      paragraphs: [{ text: "Following up with Acme.", factRefs: [applicationFactId("company")] }],
    });

    await expect(generateFollowUpDraft(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      FabricatedContentError,
    );
  });

  it("refuses the whole draft rather than dropping the offending paragraph", async () => {
    const client = makeClient();
    const model = makeModel({
      paragraphs: [VALID_RESPONSE.paragraphs[0], { text: "Unsupported.", factRefs: [] }],
    });

    await expect(generateFollowUpDraft(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      UncitedClaimError,
    );
  });

  it("reports a refused follow-up as neither a resume nor a cover letter", async () => {
    const client = makeClient();
    const model = makeModel({ paragraphs: [{ text: "An uncited claim.", factRefs: [] }] });

    const error = await generateFollowUpDraft(client, { openai: model.openai }, input).catch((e: unknown) => e);

    expect((error as Error).message).not.toContain("resume");
    expect((error as Error).message).toContain("no cited confirmed fact");
  });
});

describe("generateFollowUpDraft — refusals that are not the gate", () => {
  it("throws NoConfirmedFactsError when the candidate has nothing confirmed", async () => {
    const client = makeClient({ extracted_facts: { data: [], error: null } });
    const model = makeModel(VALID_RESPONSE);

    await expect(generateFollowUpDraft(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      NoConfirmedFactsError,
    );
    expect(model.create).not.toHaveBeenCalled();
  });

  it("throws ApplicationFactsUnavailableError when the vacancy row is gone", async () => {
    const client = makeClient({ vacancies: { data: null, error: null } });
    const model = makeModel(VALID_RESPONSE);

    await expect(generateFollowUpDraft(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      ApplicationFactsUnavailableError,
    );
    expect(model.create).not.toHaveBeenCalled();
  });

  it("refuses a third paragraph", async () => {
    const client = makeClient();
    const model = makeModel({
      paragraphs: Array.from({ length: MAX_FOLLOW_UP_PARAGRAPHS + 1 }, () => VALID_RESPONSE.paragraphs[0]),
    });

    await expect(generateFollowUpDraft(client, { openai: model.openai }, input)).rejects.toThrow(
      /at most 2 paragraphs/,
    );
  });

  it("throws on non-JSON output", async () => {
    const client = makeClient();
    const model = makeModel("Here is your follow-up:");

    await expect(generateFollowUpDraft(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      MalformedFollowUpError,
    );
  });

  it("throws when the shape is wrong", async () => {
    const client = makeClient();
    const model = makeModel({ body: "Dear hiring manager," });

    await expect(generateFollowUpDraft(client, { openai: model.openai }, input)).rejects.toBeInstanceOf(
      MalformedFollowUpError,
    );
  });
});
