import { describe, expect, it, vi } from "vitest";
import { generateResumePayload, NoConfirmedFactsError } from "./resumeGenerator.js";

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
      { extractedFactId: "fact-1", factType: "years_of_experience", factValue: "5" },
      { extractedFactId: "fact-2", factType: "current_title", factValue: "Backend Engineer" },
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
