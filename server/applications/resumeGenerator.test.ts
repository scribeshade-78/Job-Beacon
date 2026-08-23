import { describe, expect, it, vi } from "vitest";
import {
  FactualityViolationError,
  generateResumePayload,
  NoConfirmedFactsError,
  verifyFactuality,
  type ResumeFactEntry,
} from "./resumeGenerator.js";

type TableResult = { data: unknown; error: unknown };

/**
 * Same minimal thenable builder shape as eligibilityGate.test.ts's
 * makeQueryBuilder: .select()/.eq()/.in() are no-ops returning the same
 * builder, and the builder itself is thenable so array-returning queries
 * (no .single()/.maybeSingle() call) resolve directly to `result`.
 */
function makeQueryBuilder(result: TableResult) {
  const builder: PromiseLike<TableResult> & Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as PromiseLike<TableResult> & Record<string, unknown>;
  return builder;
}

function makeClient(overrides: Partial<Record<string, TableResult>> = {}) {
  const defaults: Record<string, TableResult> = {
    extracted_facts: { data: [], error: null },
    fact_confirmations: { data: [], error: null },
  };
  const results = { ...defaults, ...overrides };
  const from = vi.fn((table: string) => {
    const result = results[table];
    if (!result) {
      throw new Error(`Unexpected table: ${table}`);
    }
    return makeQueryBuilder(result);
  });
  return { from } as unknown as Parameters<typeof generateResumePayload>[0];
}

const candidateId = "candidate-1";

describe("generateResumePayload", () => {
  it("throws NoConfirmedFactsError when the candidate has no extracted facts at all", async () => {
    const client = makeClient();
    await expect(generateResumePayload(client, candidateId)).rejects.toBeInstanceOf(NoConfirmedFactsError);
  });

  it("throws NoConfirmedFactsError when facts exist but none are confirmed", async () => {
    const client = makeClient({
      extracted_facts: {
        data: [{ id: "fact-1", fact_type: "years_of_experience", fact_value: "5" }],
        error: null,
      },
      fact_confirmations: { data: [], error: null },
    });

    await expect(generateResumePayload(client, candidateId)).rejects.toBeInstanceOf(NoConfirmedFactsError);
  });

  it("builds a payload with only the confirmed facts, dropping unconfirmed ones", async () => {
    const client = makeClient({
      extracted_facts: {
        data: [
          { id: "fact-1", fact_type: "years_of_experience", fact_value: "5" },
          { id: "fact-2", fact_type: "current_title", fact_value: "Backend Engineer" },
          { id: "fact-3", fact_type: "location", fact_value: "Bengaluru" },
        ],
        error: null,
      },
      // fact-3 has no matching row here — e.g. still pending/rejected.
      fact_confirmations: {
        data: [{ extracted_fact_id: "fact-1" }, { extracted_fact_id: "fact-2" }],
        error: null,
      },
    });

    const result = await generateResumePayload(client, candidateId);

    expect(result.candidateId).toBe(candidateId);
    expect(result.facts).toEqual([
      { extractedFactId: "fact-1", factType: "years_of_experience", factValue: "5", relevant: false },
      { extractedFactId: "fact-2", factType: "current_title", factValue: "Backend Engineer", relevant: false },
    ]);
    expect(result.templateVersion).toBe("plain-json-v0");
    expect(result.modelVersion).toBe("verbatim-confirmed-facts-v0");
    expect(result.outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => new Date(result.generatedAt).toISOString()).not.toThrow();
  });

  it("produces a deterministic hash for the same confirmed facts", async () => {
    const factRows = [{ id: "fact-1", fact_type: "years_of_experience", fact_value: "5" }];
    const confirmationRows = [{ extracted_fact_id: "fact-1" }];

    const result1 = await generateResumePayload(
      makeClient({ extracted_facts: { data: factRows, error: null }, fact_confirmations: { data: confirmationRows, error: null } }),
      candidateId,
    );
    const result2 = await generateResumePayload(
      makeClient({ extracted_facts: { data: factRows, error: null }, fact_confirmations: { data: confirmationRows, error: null } }),
      candidateId,
    );

    expect(result1.outputHash).toBe(result2.outputHash);
  });

  it("produces a different hash when the confirmed facts differ", async () => {
    const result1 = await generateResumePayload(
      makeClient({
        extracted_facts: { data: [{ id: "fact-1", fact_type: "years_of_experience", fact_value: "5" }], error: null },
        fact_confirmations: { data: [{ extracted_fact_id: "fact-1" }], error: null },
      }),
      candidateId,
    );
    const result2 = await generateResumePayload(
      makeClient({
        extracted_facts: { data: [{ id: "fact-1", fact_type: "years_of_experience", fact_value: "7" }], error: null },
        fact_confirmations: { data: [{ extracted_fact_id: "fact-1" }], error: null },
      }),
      candidateId,
    );

    expect(result1.outputHash).not.toBe(result2.outputHash);
  });

  it("propagates a database error from the extracted_facts lookup", async () => {
    const client = makeClient({ extracted_facts: { data: null, error: { message: "db error" } } });
    await expect(generateResumePayload(client, candidateId)).rejects.toBeTruthy();
  });

  it("propagates a database error from the fact_confirmations lookup", async () => {
    const client = makeClient({
      extracted_facts: {
        data: [{ id: "fact-1", fact_type: "years_of_experience", fact_value: "5" }],
        error: null,
      },
      fact_confirmations: { data: null, error: { message: "db error" } },
    });

    await expect(generateResumePayload(client, candidateId)).rejects.toBeTruthy();
  });

  it("NoConfirmedFactsError carries the candidate id in its message", async () => {
    const client = makeClient();
    await expect(generateResumePayload(client, candidateId)).rejects.toThrow(/candidate-1/);
  });
});

describe("generateResumePayload — vacancy relevance annotation", () => {
  const twoFacts = [
    { id: "fact-1", fact_type: "current_title", fact_value: "Backend Engineer" },
    { id: "fact-2", fact_type: "location", fact_value: "Bengaluru" },
  ];
  const bothConfirmed = [{ extracted_fact_id: "fact-1" }, { extracted_fact_id: "fact-2" }];

  it("marks a fact relevant when its factValue is a case-insensitive substring of the vacancy title", async () => {
    const client = makeClient({
      extracted_facts: { data: twoFacts, error: null },
      fact_confirmations: { data: bothConfirmed, error: null },
    });

    const result = await generateResumePayload(client, candidateId, "Senior BACKEND ENGINEER II");

    expect(result.facts).toEqual([
      { extractedFactId: "fact-1", factType: "current_title", factValue: "Backend Engineer", relevant: true },
      { extractedFactId: "fact-2", factType: "location", factValue: "Bengaluru", relevant: false },
    ]);
  });

  it("follows evaluateRoleMatch's own substring direction: the vacancy title must include the fact value, not the reverse", async () => {
    const client = makeClient({
      extracted_facts: { data: [{ id: "fact-1", fact_type: "current_title", fact_value: "Senior Backend Engineer" }], error: null },
      fact_confirmations: { data: [{ extracted_fact_id: "fact-1" }], error: null },
    });

    // The fact value is longer than the title, so the title cannot include it.
    const result = await generateResumePayload(client, candidateId, "Backend Engineer");

    expect(result.facts).toEqual([
      { extractedFactId: "fact-1", factType: "current_title", factValue: "Senior Backend Engineer", relevant: false },
    ]);
  });

  it("keeps every confirmed fact in the payload regardless of match, never silently filtering one out", async () => {
    const client = makeClient({
      extracted_facts: { data: twoFacts, error: null },
      fact_confirmations: { data: bothConfirmed, error: null },
    });

    const result = await generateResumePayload(client, candidateId, "Backend Engineer");

    expect(result.facts).toHaveLength(2);
    expect(result.facts.map((fact) => fact.extractedFactId)).toEqual(["fact-1", "fact-2"]);
  });

  it("annotates every confirmed fact as not relevant, without dropping any, when vacancyTitle is omitted", async () => {
    const client = makeClient({
      extracted_facts: { data: twoFacts, error: null },
      fact_confirmations: { data: bothConfirmed, error: null },
    });

    const result = await generateResumePayload(client, candidateId);

    expect(result.facts).toHaveLength(2);
    expect(result.facts.every((fact) => fact.relevant === false)).toBe(true);
  });

  it("treats a blank/whitespace-only vacancyTitle the same as a missing one, not as matching every fact", async () => {
    const client = makeClient({
      extracted_facts: { data: twoFacts, error: null },
      fact_confirmations: { data: bothConfirmed, error: null },
    });

    const result = await generateResumePayload(client, candidateId, "   ");

    expect(result.facts.every((fact) => fact.relevant === false)).toBe(true);
  });
});

describe("generateResumePayload — MP-F2 corrected_value precedence", () => {
  it("uses corrected_value over extracted_facts.fact_value when the candidate edited a confirmed fact", async () => {
    const client = makeClient({
      extracted_facts: {
        data: [{ id: "fact-1", fact_type: "years_of_experience", fact_value: "5" }],
        error: null,
      },
      fact_confirmations: {
        data: [{ extracted_fact_id: "fact-1", corrected_value: "7" }],
        error: null,
      },
    });

    const result = await generateResumePayload(client, candidateId);

    expect(result.facts).toEqual([
      { extractedFactId: "fact-1", factType: "years_of_experience", factValue: "7", relevant: false },
    ]);
  });

  it("falls back to extracted_facts.fact_value when corrected_value is null (confirmed as-is)", async () => {
    const client = makeClient({
      extracted_facts: {
        data: [{ id: "fact-1", fact_type: "years_of_experience", fact_value: "5" }],
        error: null,
      },
      fact_confirmations: {
        data: [{ extracted_fact_id: "fact-1", corrected_value: null }],
        error: null,
      },
    });

    const result = await generateResumePayload(client, candidateId);

    expect(result.facts[0].factValue).toBe("5");
  });

  it("never mutates extracted_facts — the corrected value only ever comes from fact_confirmations", async () => {
    const factRows = [{ id: "fact-1", fact_type: "current_title", fact_value: "Backend Engineer" }];
    const client = makeClient({
      extracted_facts: { data: factRows, error: null },
      fact_confirmations: {
        data: [{ extracted_fact_id: "fact-1", corrected_value: "Senior Backend Engineer" }],
        error: null,
      },
    });

    await generateResumePayload(client, candidateId);

    // The in-memory fixture row itself is untouched by generateResumePayload.
    expect(factRows[0].fact_value).toBe("Backend Engineer");
  });

  it("matches vacancy relevance against the corrected value, not the stale extracted value", async () => {
    const client = makeClient({
      extracted_facts: {
        data: [{ id: "fact-1", fact_type: "current_title", fact_value: "Some Other Title" }],
        error: null,
      },
      fact_confirmations: {
        data: [{ extracted_fact_id: "fact-1", corrected_value: "Backend Engineer" }],
        error: null,
      },
    });

    const result = await generateResumePayload(client, candidateId, "Senior Backend Engineer II");

    expect(result.facts[0]).toEqual({
      extractedFactId: "fact-1",
      factType: "current_title",
      factValue: "Backend Engineer",
      relevant: true,
    });
  });
});

describe("verifyFactuality", () => {
  it("passes without throwing when every fact traces to a confirmed extracted_facts id", () => {
    const facts: ResumeFactEntry[] = [
      { extractedFactId: "fact-1", factType: "current_title", factValue: "Backend Engineer", relevant: false },
    ];
    expect(() => verifyFactuality(facts, new Set(["fact-1"]))).not.toThrow();
  });

  it("rejects a deliberately constructed payload containing a fact absent from the confirmed set", () => {
    const facts: ResumeFactEntry[] = [
      { extractedFactId: "fact-1", factType: "current_title", factValue: "Backend Engineer", relevant: false },
      { extractedFactId: "fact-not-confirmed", factType: "location", factValue: "Bengaluru", relevant: false },
    ];
    expect(() => verifyFactuality(facts, new Set(["fact-1"]))).toThrow(FactualityViolationError);
  });

  it("identifies the offending extractedFactId on the thrown error", () => {
    const facts: ResumeFactEntry[] = [
      { extractedFactId: "fact-unconfirmed", factType: "current_title", factValue: "Backend Engineer", relevant: false },
    ];
    try {
      verifyFactuality(facts, new Set());
      throw new Error("expected verifyFactuality to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FactualityViolationError);
      expect((error as FactualityViolationError).extractedFactId).toBe("fact-unconfirmed");
    }
  });
});
