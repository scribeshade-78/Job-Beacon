import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { prepareInterviewPrep } from "./interviewPrep.js";
import type { RawInterviewPrep } from "./prepPrompt.js";

type TableResult = { data: unknown; error?: unknown };

/**
 * A chainable, awaitable fake of the Supabase query builder.
 *
 * Awaitability is not decoration: these modules await `.eq(...)` directly for
 * the list-shaped queries and call `.maybeSingle()` for the single-row ones, so
 * the fake has to support both shapes or the tests exercise a query path the
 * real code never takes.
 */
function makeClient(tables: Record<string, TableResult>) {
  function builderFor(table: string) {
    const result = tables[table] ?? { data: [], error: null };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;

    for (const method of ["select", "eq", "in", "order", "limit"]) {
      builder[method] = chain;
    }

    builder.maybeSingle = () => Promise.resolve(result);
    builder.then = (resolve: (value: TableResult) => unknown) => resolve(result);

    return builder;
  }

  return { from: (table: string) => builderFor(table) } as unknown as Pick<SupabaseClient, "from">;
}

const VALID_PREP: RawInterviewPrep = {
  technical_questions: [{ question: "How do you tune Postgres?", topic: "Postgres", why: "The JD requires it." }],
  behavioral_questions: [{ question: "Describe a conflict.", competency: "conflict resolution", why: "Cross-team." }],
  star_talking_points: [],
  gaps: [],
};

function mockOpenAI(content: string | null = JSON.stringify(VALID_PREP)) {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content } }] });
  return { client: { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">, create };
}

function baseTables(over: Record<string, TableResult> = {}): Record<string, TableResult> {
  return {
    vacancies: { data: { raw_title: "Senior Platform Engineer" } },
    vacancy_jd_snapshots: { data: { clean_text: "We need a platform engineer with Postgres and Go." } },
    extracted_facts: { data: [{ id: "f1", fact_type: "skill", fact_value: "Postgres" }] },
    fact_confirmations: { data: [{ extracted_fact_id: "f1", corrected_value: null }] },
    ...over,
  };
}

function userMessage(create: ReturnType<typeof vi.fn>): string {
  const messages = create.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
  return messages.find((m) => m.role === "user")!.content;
}

const PARAMS = { vacancyId: "vacancy-1", candidateId: "candidate-1" };

describe("prepareInterviewPrep — guards", () => {
  it("returns vacancy_not_found when the vacancy row is absent", async () => {
    const client = makeClient(baseTables({ vacancies: { data: null } }));

    const result = await prepareInterviewPrep(client, mockOpenAI().client, PARAMS);

    expect(result).toEqual({ kind: "vacancy_not_found" });
  });

  it("returns no_jd_text when the vacancy has no JD snapshot", async () => {
    const client = makeClient(baseTables({ vacancy_jd_snapshots: { data: null } }));

    const result = await prepareInterviewPrep(client, mockOpenAI().client, PARAMS);

    expect(result).toEqual({ kind: "no_jd_text" });
  });

  it("treats whitespace-only JD text as absent rather than generating from nothing", async () => {
    const client = makeClient(baseTables({ vacancy_jd_snapshots: { data: { clean_text: "   \n  " } } }));
    const { client: ai, create } = mockOpenAI();

    const result = await prepareInterviewPrep(client, ai, PARAMS);

    expect(result).toEqual({ kind: "no_jd_text" });
    // The important half of this assertion: no model call was made at all.
    expect(create).not.toHaveBeenCalled();
  });
});

describe("prepareInterviewPrep — success path", () => {
  it("returns the generated prep", async () => {
    const client = makeClient(baseTables());

    const result = await prepareInterviewPrep(client, mockOpenAI().client, PARAMS);

    expect(result).toEqual({ kind: "success", prep: VALID_PREP });
  });

  it("sends the role title, the JD and the confirmed facts to the model", async () => {
    const client = makeClient(baseTables());
    const { client: ai, create } = mockOpenAI();

    await prepareInterviewPrep(client, ai, PARAMS);

    const sent = userMessage(create);
    expect(sent).toContain("ROLE: Senior Platform Engineer");
    expect(sent).toContain("Postgres and Go");
    expect(sent).toContain("- skill: Postgres");
  });
});

describe("prepareInterviewPrep — candidate context is confirmed-only", () => {
  it("omits a fact that has no confirmed row", async () => {
    const client = makeClient(
      baseTables({
        extracted_facts: {
          data: [
            { id: "f1", fact_type: "skill", fact_value: "Postgres" },
            { id: "f2", fact_type: "skill", fact_value: "Rust" },
          ],
        },
        fact_confirmations: { data: [{ extracted_fact_id: "f1", corrected_value: null }] },
      }),
    );
    const { client: ai, create } = mockOpenAI();

    await prepareInterviewPrep(client, ai, PARAMS);

    const sent = userMessage(create);
    expect(sent).toContain("Postgres");
    // An unreviewed extraction must never reach the model as a qualification.
    expect(sent).not.toContain("Rust");
  });

  it("prefers corrected_value over the raw extracted value", async () => {
    const client = makeClient(
      baseTables({
        extracted_facts: { data: [{ id: "f1", fact_type: "skill", fact_value: "Postgres" }] },
        fact_confirmations: { data: [{ extracted_fact_id: "f1", corrected_value: "Postgres 14" }] },
      }),
    );
    const { client: ai, create } = mockOpenAI();

    await prepareInterviewPrep(client, ai, PARAMS);

    const sent = userMessage(create);
    expect(sent).toContain("- skill: Postgres 14");
    expect(sent).not.toContain("- skill: Postgres\n");
  });

  it("still generates from the JD alone when the candidate has confirmed nothing", async () => {
    const client = makeClient(baseTables({ extracted_facts: { data: [] } }));
    const { client: ai, create } = mockOpenAI(JSON.stringify({ ...VALID_PREP, star_talking_points: [] }));

    const result = await prepareInterviewPrep(client, ai, PARAMS);

    expect(result.kind).toBe("success");
    expect(create).toHaveBeenCalledOnce();
    expect(userMessage(create)).toContain("(none confirmed");
  });

  it("still generates when facts exist but none are confirmed", async () => {
    const client = makeClient(baseTables({ fact_confirmations: { data: [] } }));

    const result = await prepareInterviewPrep(client, mockOpenAI().client, PARAMS);

    expect(result.kind).toBe("success");
  });
});

describe("prepareInterviewPrep — failure mapping", () => {
  it("maps malformed AI output to malformed_prep, not to an error", async () => {
    const client = makeClient(baseTables());

    const result = await prepareInterviewPrep(client, mockOpenAI("{ not json").client, PARAMS);

    expect(result.kind).toBe("malformed_prep");
  });

  it("maps a throwing AI client to error", async () => {
    const create = vi.fn().mockRejectedValue(new Error("OpenRouter 503"));
    const ai = { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">;
    const client = makeClient(baseTables());

    const result = await prepareInterviewPrep(client, ai, PARAMS);

    expect(result).toEqual({ kind: "error", message: "OpenRouter 503" });
  });

  it("maps a database failure to error", async () => {
    const client = makeClient(baseTables({ vacancies: { data: null, error: { message: "connection reset" } } }));

    const result = await prepareInterviewPrep(client, mockOpenAI().client, PARAMS);

    expect(result.kind).toBe("error");
  });
});
