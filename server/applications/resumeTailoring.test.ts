import { describe, expect, it, vi } from "vitest";
import {
  AGGRESSIVE_SYSTEM_PROMPT,
  DEFAULT_RESUME_OPTIMIZATION_LEVEL,
  FabricatedContentError,
  HONEST_SYSTEM_PROMPT,
  MalformedTailoredResumeError,
  MissingBaseResumeError,
  RESUME_TAILORING_PROMPT_VERSION,
  UncitedClaimError,
  readResumeOptimizationLevel,
  systemPromptFor,
  tailorResumeForVacancy,
} from "./resumeGenerator.js";

type TableResult = { data: unknown; error: unknown };

/**
 * Every query shape tailorResumeForVacancy can reach: a chained builder whose
 * terminal is either an array resolution (no .maybeSingle()) or a single row.
 * .order()/.limit() exist so the vacancy_jd_snapshots "latest snapshot" query
 * is reachable too.
 */
function makeQueryBuilder(result: TableResult) {
  const builder: PromiseLike<TableResult> & Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as PromiseLike<TableResult> & Record<string, unknown>;
  return builder;
}

const CANDIDATE_ID = "candidate-1";
const VACANCY_ID = "vacancy-1";

const CONFIRMED_FACTS = [
  { id: "fact-1", fact_type: "current_title", fact_value: "Senior Data Engineer" },
  { id: "fact-2", fact_type: "skill", fact_value: "Apache Spark" },
];

function makeClient(overrides: Partial<Record<string, TableResult>> = {}) {
  const defaults: Record<string, TableResult> = {
    candidate_profiles: { data: { resume_optimization_level: "honest" }, error: null },
    extracted_facts: { data: CONFIRMED_FACTS, error: null },
    fact_confirmations: {
      data: CONFIRMED_FACTS.map((fact) => ({ extracted_fact_id: fact.id, corrected_value: null })),
      error: null,
    },
    vacancies: { data: { raw_title: "Staff Data Engineer" }, error: null },
    vacancy_jd_snapshots: { data: { clean_text: "Spark, Airflow, SQL" }, error: null },
    resume_documents: {
      data: {
        id: "doc-base-1",
        storage_path: "candidate-1/base-resume.pdf",
        original_filename: "base-resume.pdf",
        mime_type: "application/pdf",
      },
      error: null,
    },
  };
  const results = { ...defaults, ...overrides };
  const from = vi.fn((table: string) => {
    const result = results[table];
    if (!result) {
      throw new Error(`Unexpected table: ${table}`);
    }
    return makeQueryBuilder(result);
  });
  return { from, tablesQueried: () => from.mock.calls.map((call) => call[0]) };
}

/** The subset of the chat-completions request these tests assert on. */
interface ChatCall {
  messages: Array<{ role: string; content: string }>;
}

function makeModel(response: unknown) {
  const create = vi.fn(async (_body: ChatCall) => ({
    choices: [{ message: { content: typeof response === "string" ? response : JSON.stringify(response) } }],
  }));
  // Cast matches fitPrompt.test.ts's fakeClient: the real OpenAI type carries
  // private members a stub cannot have.
  return { openai: { chat: { completions: { create } } } as never, create };
}

/** A fully grounded response: no claim, including skills, is left uncited. */
const VALID_RESPONSE = {
  headline: { text: "Senior Data Engineer", factRefs: ["fact-1"] },
  summary: { text: "Data engineer working in Apache Spark.", factRefs: ["fact-1", "fact-2"] },
  bullets: [
    { text: "Works in Apache Spark", factRefs: ["fact-2"] },
    { text: "Senior Data Engineer", factRefs: ["fact-1"] },
  ],
  skills: [{ text: "Apache Spark", factRefs: ["fact-2"] }],
};

type ModelStub = ReturnType<typeof makeModel>["create"];

function messageOf(create: ModelStub, role: "system" | "user"): string {
  return create.mock.calls[0]?.[0]?.messages.find((message) => message.role === role)?.content ?? "";
}

/** The system message of the first (and only) model call. */
function systemMessageOf(create: ModelStub): string {
  return messageOf(create, "system");
}

function userMessageOf(create: ModelStub): string {
  return messageOf(create, "user");
}

describe("systemPromptFor", () => {
  it("returns no prompt at all for off, so there is nothing to send", () => {
    expect(systemPromptFor("off")).toBeNull();
  });

  it("returns the honest prompt for honest and the aggressive prompt for aggressive", () => {
    expect(systemPromptFor("honest")).toBe(HONEST_SYSTEM_PROMPT);
    expect(systemPromptFor("aggressive")).toBe(AGGRESSIVE_SYSTEM_PROMPT);
  });

  it("gives the two rewriting levels genuinely different instructions", () => {
    expect(HONEST_SYSTEM_PROMPT).not.toBe(AGGRESSIVE_SYSTEM_PROMPT);
  });

  it("forbids invention in both rewriting prompts, so aggressive is not a licence to fabricate", () => {
    for (const prompt of [HONEST_SYSTEM_PROMPT, AGGRESSIVE_SYSTEM_PROMPT]) {
      expect(prompt).toContain("only source of truth");
      expect(prompt.toLowerCase()).toContain("must not");
      expect(prompt).toContain("extractedFactIds");
    }
  });

  it("tells the model every field needs its own citations, including skills", () => {
    for (const prompt of [HONEST_SYSTEM_PROMPT, AGGRESSIVE_SYSTEM_PROMPT]) {
      expect(prompt).toContain('"skills"');
      expect(prompt).toContain("never added to them");
    }
  });
});

describe("readResumeOptimizationLevel", () => {
  it("returns the stored preference", async () => {
    const client = makeClient({ candidate_profiles: { data: { resume_optimization_level: "aggressive" }, error: null } });
    await expect(readResumeOptimizationLevel(client as never, CANDIDATE_ID)).resolves.toBe("aggressive");
  });

  it("falls back to the column default when the profile row has no value", async () => {
    const client = makeClient({ candidate_profiles: { data: { resume_optimization_level: null }, error: null } });
    await expect(readResumeOptimizationLevel(client as never, CANDIDATE_ID)).resolves.toBe(
      DEFAULT_RESUME_OPTIMIZATION_LEVEL,
    );
  });

  it("falls back to the column default for an unrecognised value rather than failing an application", async () => {
    const client = makeClient({ candidate_profiles: { data: { resume_optimization_level: "turbo" }, error: null } });
    await expect(readResumeOptimizationLevel(client as never, CANDIDATE_ID)).resolves.toBe(
      DEFAULT_RESUME_OPTIMIZATION_LEVEL,
    );
  });
});

describe("tailorResumeForVacancy — off bypasses the model entirely", () => {
  it("never calls the model when the preference is off", async () => {
    const client = makeClient({ candidate_profiles: { data: { resume_optimization_level: "off" }, error: null } });
    const model = makeModel(VALID_RESPONSE);

    const result = await tailorResumeForVacancy(client as never, model, {
      candidateId: CANDIDATE_ID,
      vacancyId: VACANCY_ID,
    });

    expect(model.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "bypassed", level: "off" });
  });

  it("does not even read facts or the job description when the preference is off", async () => {
    const client = makeClient({ candidate_profiles: { data: { resume_optimization_level: "off" }, error: null } });
    const model = makeModel(VALID_RESPONSE);

    await tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID });

    // The bypass is positional, not just "the model call happens to be skipped":
    // off touches the preference and the stored base resume, and never reaches
    // the fact query, the posting query, or the model.
    expect(client.tablesQueried()).toEqual(["candidate_profiles", "resume_documents"]);
  });

  it("succeeds with off even when the candidate has no confirmed facts to tailor from", async () => {
    const client = makeClient({
      candidate_profiles: { data: { resume_optimization_level: "off" }, error: null },
      extracted_facts: { data: [], error: null },
    });
    const model = makeModel(VALID_RESPONSE);

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).resolves.toMatchObject({ kind: "bypassed" });
    expect(model.create).not.toHaveBeenCalled();
  });

  it("returns the stored base resume, so off still submits a real file", async () => {
    const client = makeClient({ candidate_profiles: { data: { resume_optimization_level: "off" }, error: null } });

    const result = await tailorResumeForVacancy(client as never, makeModel(VALID_RESPONSE), {
      candidateId: CANDIDATE_ID,
      vacancyId: VACANCY_ID,
    });

    expect(result.kind === "bypassed" && result.baseResume).toEqual({
      documentId: "doc-base-1",
      storagePath: "candidate-1/base-resume.pdf",
      originalFilename: "base-resume.pdf",
      mimeType: "application/pdf",
      // null, not 'off': nothing produced this file, and asserting a level for
      // it would claim the engine rewrote something it did not touch.
      optimizationLevel: null,
    });
  });

  it("fails clearly when there is no base resume to fall back to", async () => {
    const client = makeClient({
      candidate_profiles: { data: { resume_optimization_level: "off" }, error: null },
      resume_documents: { data: null, error: null },
    });

    await expect(
      tailorResumeForVacancy(client as never, makeModel(VALID_RESPONSE), {
        candidateId: CANDIDATE_ID,
        vacancyId: VACANCY_ID,
      }),
    ).rejects.toBeInstanceOf(MissingBaseResumeError);
  });

  it("explains why nothing was rewritten, so the UI can say so honestly", async () => {
    const client = makeClient({ candidate_profiles: { data: { resume_optimization_level: "off" }, error: null } });
    const result = await tailorResumeForVacancy(client as never, makeModel(VALID_RESPONSE), {
      candidateId: CANDIDATE_ID,
      vacancyId: VACANCY_ID,
    });

    expect(result.kind === "bypassed" && result.reason).toMatch(/no model call is made/);
  });
});

describe("tailorResumeForVacancy — honest and aggressive build the right prompt", () => {
  it("sends the honest system prompt for an honest preference", async () => {
    const client = makeClient({ candidate_profiles: { data: { resume_optimization_level: "honest" }, error: null } });
    const model = makeModel(VALID_RESPONSE);

    const result = await tailorResumeForVacancy(client as never, model, {
      candidateId: CANDIDATE_ID,
      vacancyId: VACANCY_ID,
    });

    expect(model.create).toHaveBeenCalledTimes(1);
    expect(systemMessageOf(model.create)).toBe(HONEST_SYSTEM_PROMPT);
    expect(result).toMatchObject({ kind: "generated", level: "honest" });
  });

  it("sends the aggressive system prompt — and not the honest one — for an aggressive preference", async () => {
    const client = makeClient({ candidate_profiles: { data: { resume_optimization_level: "aggressive" }, error: null } });
    const model = makeModel(VALID_RESPONSE);

    const result = await tailorResumeForVacancy(client as never, model, {
      candidateId: CANDIDATE_ID,
      vacancyId: VACANCY_ID,
    });

    expect(systemMessageOf(model.create)).toBe(AGGRESSIVE_SYSTEM_PROMPT);
    expect(systemMessageOf(model.create)).not.toBe(HONEST_SYSTEM_PROMPT);
    expect(result).toMatchObject({ kind: "generated", level: "aggressive" });
  });

  it("hands the model the confirmed facts with their ids, and the posting text", async () => {
    const client = makeClient({ candidate_profiles: { data: { resume_optimization_level: "honest" }, error: null } });
    const model = makeModel(VALID_RESPONSE);

    await tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID });

    const userMessage = userMessageOf(model.create);
    expect(userMessage).toContain("[fact-1] (current_title) Senior Data Engineer");
    expect(userMessage).toContain("[fact-2] (skill) Apache Spark");
    expect(userMessage).toContain("Staff Data Engineer");
    expect(userMessage).toContain("Spark, Airflow, SQL");
  });

  it("says the posting description is missing instead of implying it had one", async () => {
    const client = makeClient({
      candidate_profiles: { data: { resume_optimization_level: "honest" }, error: null },
      vacancy_jd_snapshots: { data: null, error: null },
    });
    const model = makeModel(VALID_RESPONSE);

    await tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID });

    expect(userMessageOf(model.create)).toContain("Description: none available");
  });

  it("records the model and prompt versions on the generated result", async () => {
    const client = makeClient();
    const model = makeModel(VALID_RESPONSE);

    const result = await tailorResumeForVacancy(client as never, model, {
      candidateId: CANDIDATE_ID,
      vacancyId: VACANCY_ID,
      model: "test/model-v1",
    });

    expect(result).toMatchObject({
      kind: "generated",
      modelVersion: "test/model-v1",
      promptVersion: RESUME_TAILORING_PROMPT_VERSION,
      citedFactCount: 2,
    });
  });
});

describe("tailorResumeForVacancy — refuses content built on facts the candidate never confirmed", () => {
  it("throws when a bullet cites a fact id that is not a confirmed fact", async () => {
    const client = makeClient();
    const model = makeModel({
      ...VALID_RESPONSE,
      bullets: [{ text: "Led a team of ten", factRefs: ["fact-1", "fact-invented"] }],
    });

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).rejects.toBeInstanceOf(FabricatedContentError);
  });

  it("names the offending ids on the error, so the failure is actionable", async () => {
    const client = makeClient();
    const model = makeModel({
      ...VALID_RESPONSE,
      bullets: [{ text: "Made things up", factRefs: ["ghost-a", "ghost-b"] }],
    });

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).rejects.toMatchObject({ unknownFactRefs: ["ghost-a", "ghost-b"] });
  });

  it("refuses the whole result rather than keeping the well-cited bullets", async () => {
    const client = makeClient();
    const model = makeModel({
      ...VALID_RESPONSE,
      bullets: [
        { text: "Fine bullet", factRefs: ["fact-1"] },
        { text: "Invented bullet", factRefs: ["fact-nope"] },
      ],
    });

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).rejects.toBeInstanceOf(FabricatedContentError);
  });

  it("catches an invented skill, which carries no bullet to give it away", async () => {
    const client = makeClient();
    const model = makeModel({
      ...VALID_RESPONSE,
      // "Kubernetes" appears in no confirmed fact. A skills list is the single
      // most damaging place to let this through, which is why skills are
      // grounded claims rather than bare strings.
      skills: [{ text: "Kubernetes", factRefs: ["fact-does-not-exist"] }],
    });

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).rejects.toBeInstanceOf(FabricatedContentError);
  });

  it("catches an invented claim in the summary, not just in the bullets", async () => {
    const client = makeClient();
    const model = makeModel({
      ...VALID_RESPONSE,
      summary: { text: "Ten years leading platform teams", factRefs: ["fact-nope"] },
    });

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).rejects.toBeInstanceOf(FabricatedContentError);
  });

  it("accepts content whose citations are all real confirmed facts", async () => {
    const client = makeClient();
    const model = makeModel(VALID_RESPONSE);

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).resolves.toMatchObject({ kind: "generated", citedFactCount: 2 });
  });
});

describe("tailorResumeForVacancy — a claim with no citation is refused", () => {
  it("throws when a bullet states something and cites nothing", async () => {
    const client = makeClient();
    const model = makeModel({
      ...VALID_RESPONSE,
      bullets: [{ text: "Managed a team of ten engineers", factRefs: [] }],
    });

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).rejects.toBeInstanceOf(UncitedClaimError);
  });

  it("throws when the only uncited claim is in the skills list", async () => {
    const client = makeClient();
    const model = makeModel({ ...VALID_RESPONSE, skills: [{ text: "Terraform", factRefs: [] }] });

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).rejects.toBeInstanceOf(UncitedClaimError);
  });

  it("quotes the uncited text, so the failure says what it objected to", async () => {
    const client = makeClient();
    const model = makeModel({ ...VALID_RESPONSE, summary: { text: "Award-winning architect", factRefs: [] } });

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).rejects.toMatchObject({ uncitedTexts: ["Award-winning architect"] });
  });

  it("allows an empty section with no citations, so a model can honestly omit what it cannot ground", async () => {
    const client = makeClient();
    const model = makeModel({ ...VALID_RESPONSE, summary: { text: "", factRefs: [] } });

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).resolves.toMatchObject({ kind: "generated" });
  });

  it("refuses a result where every section came back empty", async () => {
    const client = makeClient();
    const model = makeModel({
      headline: { text: "", factRefs: [] },
      summary: { text: "   ", factRefs: [] },
      bullets: [],
      skills: [],
    });

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).rejects.toBeInstanceOf(MalformedTailoredResumeError);
  });
});

describe("tailorResumeForVacancy — malformed model output is rejected, not patched up", () => {
  it("throws on non-JSON content", async () => {
    const client = makeClient();
    const model = makeModel("Sure! Here is your resume: ...");

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).rejects.toBeInstanceOf(MalformedTailoredResumeError);
  });

  it("throws when the JSON is valid but the shape is wrong", async () => {
    const client = makeClient();
    const model = makeModel({ headline: "x", summary: "y" });

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).rejects.toBeInstanceOf(MalformedTailoredResumeError);
  });

  it("throws when a bare string is returned where a grounded claim belongs", async () => {
    const client = makeClient();
    const model = makeModel({ ...VALID_RESPONSE, headline: "Senior Data Engineer" });

    await expect(
      tailorResumeForVacancy(client as never, model, { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID }),
    ).rejects.toBeInstanceOf(MalformedTailoredResumeError);
  });

  it("throws when the model returns empty content", async () => {
    const client = makeClient();
    const create = vi.fn(async (_body: ChatCall) => ({ choices: [{ message: { content: "" } }] }));

    await expect(
      tailorResumeForVacancy(
        client as never,
        { openai: { chat: { completions: { create } } } } as never,
        { candidateId: CANDIDATE_ID, vacancyId: VACANCY_ID },
      ),
    ).rejects.toBeInstanceOf(MalformedTailoredResumeError);
  });
});
