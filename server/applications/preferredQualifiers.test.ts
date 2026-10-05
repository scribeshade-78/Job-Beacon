import { describe, expect, it, vi } from "vitest";
import { loadPreferredQualifiers } from "./preferredQualifiers.js";

/**
 * Preferred qualifiers, loaded for the eligibility explanation.
 *
 * MOCKED CLIENT, NOT DATABASE VALIDATION: the read is asserted as emitted and
 * the mapping as returned; RLS and the columns themselves are unexecuted.
 */

function makeClient(result: { data?: unknown; error?: unknown }) {
  const filters: Array<[string, unknown]> = [];
  const selected: string[] = [];

  const builder: any = {
    select: (columns: string) => {
      selected.push(columns);
      return builder;
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };

  const client = { from: vi.fn(() => builder) } as never;
  return { client, filters, selected };
}

describe("loadPreferredQualifiers", () => {
  it("reduces recorded raw intent to the words the canonical role does not say", async () => {
    const { client } = makeClient({
      data: [{ role_name: "Data Engineer", raw_role_name: "Azure Data Engineer" }],
      error: null,
    });

    const result = await loadPreferredQualifiers(client, "candidate-1");

    expect(result.qualifiers).toEqual(["azure"]);
    expect(result.label).toBe("Azure preferred");
  });

  it("scopes the read to the candidate", async () => {
    const { client, filters } = makeClient({ data: [], error: null });

    await loadPreferredQualifiers(client, "candidate-1");

    expect(filters).toEqual([["candidate_id", "candidate-1"]]);
  });

  it("reads the raw phrase column, not only role_name", async () => {
    const { client, selected } = makeClient({ data: [], error: null });

    await loadPreferredQualifiers(client, "candidate-1");

    expect(selected[0]).toContain("raw_role_name");
  });

  it("keeps a legacy row UNKNOWN rather than deriving intent from role_name", async () => {
    const { client } = makeClient({
      data: [{ role_name: "Data Engineer", raw_role_name: null }],
      error: null,
    });

    const result = await loadPreferredQualifiers(client, "candidate-1");

    expect(result).toEqual({ qualifiers: [], label: null });
  });

  it("collects across selections without duplicating a qualifier", async () => {
    const { client } = makeClient({
      data: [
        { role_name: "Data Engineer", raw_role_name: "Azure Data Engineer" },
        { role_name: "Data Analyst", raw_role_name: "Azure Data Analyst" },
      ],
      error: null,
    });

    const result = await loadPreferredQualifiers(client, "candidate-1");

    expect(result.qualifiers).toEqual(["azure"]);
  });

  it("returns nothing when no preference is recorded", async () => {
    const { client } = makeClient({ data: [], error: null });

    expect(await loadPreferredQualifiers(client, "candidate-1")).toEqual({ qualifiers: [], label: null });
  });

  it("throws on a query error instead of reporting no preferences", async () => {
    const { client } = makeClient({ data: null, error: { message: "roles unavailable" } });

    await expect(loadPreferredQualifiers(client, "candidate-1")).rejects.toBeTruthy();
  });
});
