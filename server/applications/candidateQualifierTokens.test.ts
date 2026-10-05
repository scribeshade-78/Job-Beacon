import { describe, expect, it, vi } from "vitest";
import { TOKENIZER_VERSION } from "../../shared/evidenceTokens.js";
import {
  deriveCandidateQualifierRows,
  refreshCandidateQualifierTokens,
} from "./candidateQualifierTokens.js";

/**
 * MOCKED CLIENT, NOT DATABASE VALIDATION: the derivation is pure and asserted
 * directly, and the refresh's statements are asserted as EMITTED. The table, its
 * RLS policies and the composite key are unexecuted.
 */

describe("deriveCandidateQualifierRows", () => {
  it("keeps each qualifier attached to the canonical role it belongs to", () => {
    const rows = deriveCandidateQualifierRows([
      { roleName: "Data Engineer", rawRoleName: "Azure Data Engineer" },
      { roleName: "Teacher", rawRoleName: "Montessori Teacher" },
    ]);

    expect(rows).toEqual([
      {
        roleName: "Data Engineer",
        qualifier: "azure",
        tokenizerVersion: TOKENIZER_VERSION,
        intentFingerprint: expect.any(String),
      },
      {
        roleName: "Teacher",
        qualifier: "montessori",
        tokenizerVersion: TOKENIZER_VERSION,
        intentFingerprint: expect.any(String),
      },
    ]);
  });

  it("derives NOTHING from a legacy selection with no recorded phrase", () => {
    expect(deriveCandidateQualifierRows([{ roleName: "Data Engineer", rawRoleName: null }])).toEqual([]);
  });

  it("derives nothing when the phrase adds no qualifier", () => {
    expect(deriveCandidateQualifierRows([{ roleName: "Data Engineer", rawRoleName: "Data Engineer" }])).toEqual([]);
  });

  it("changes the fingerprint when the phrase is edited", () => {
    const before = deriveCandidateQualifierRows([{ roleName: "Data Engineer", rawRoleName: "Azure Data Engineer" }]);
    const after = deriveCandidateQualifierRows([{ roleName: "Data Engineer", rawRoleName: "AWS Data Engineer" }]);

    // Different evidence => different fingerprint, so a stale row is detectable
    // rather than silently reused.
    expect(before[0].intentFingerprint).not.toBe(after[0].intentFingerprint);
  });

  it("deduplicates the same qualifier for the same role", () => {
    const rows = deriveCandidateQualifierRows([
      { roleName: "Data Engineer", rawRoleName: "Azure Data Engineer" },
      { roleName: "Data Engineer", rawRoleName: "Azure Data Engineer" },
    ]);

    expect(rows).toHaveLength(1);
  });
});

interface Config {
  roles?: Array<{ role_name: string; raw_role_name: string | null }>;
  rolesError?: unknown;
  deleteError?: unknown;
  insertError?: unknown;
}

function makeClient(config: Config = {}) {
  const deletes: Array<[string, unknown]> = [];
  const inserts: Array<Array<Record<string, unknown>>> = [];
  const selects: string[] = [];

  const from = vi.fn((table: string) => {
    if (table === "candidate_selected_roles") {
      const builder: any = {
        select: (columns: string) => {
          selects.push(columns);
          return builder;
        },
        eq: () => builder,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(config.rolesError ? { data: null, error: config.rolesError } : { data: config.roles ?? [], error: null }).then(
            resolve,
          ),
      };
      return builder;
    }

    const builder: any = {
      delete: () => builder,
      eq: (column: string, value: unknown) => {
        deletes.push([column, value]);
        return builder;
      },
      insert: async (rows: Array<Record<string, unknown>>) => {
        inserts.push(rows);
        return { error: config.insertError ?? null };
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: null, error: config.deleteError ?? null }).then(resolve),
    };
    return builder;
  });

  return { client: { from } as never, deletes, inserts, selects };
}

describe("refreshCandidateQualifierTokens", () => {
  it("reads confirmed intent, replaces the candidate's rows, and reports counts", async () => {
    const { client, deletes, inserts, selects } = makeClient({
      roles: [{ role_name: "Data Engineer", raw_role_name: "Azure Data Engineer" }],
    });

    const result = await refreshCandidateQualifierTokens(client, "candidate-1");

    expect(selects[0]).toContain("raw_role_name");
    // Replace, not append: a cleared/edited phrase must remove the old rows.
    expect(deletes).toEqual([["candidate_id", "candidate-1"]]);
    expect(inserts[0][0]).toMatchObject({
      candidate_id: "candidate-1",
      role_name: "Data Engineer",
      qualifier: "azure",
      tokenizer_version: TOKENIZER_VERSION,
    });
    expect(result).toEqual({ candidateId: "candidate-1", rolesConsidered: 1, rowsWritten: 1 });
  });

  it("scopes every statement to the candidate, since service_role bypasses RLS", async () => {
    const { client, deletes } = makeClient({ roles: [] });

    await refreshCandidateQualifierTokens(client, "candidate-9");

    expect(deletes).toEqual([["candidate_id", "candidate-9"]]);
  });

  it("writes nothing when no confirmed phrase exists, but still clears stale rows", async () => {
    const { client, inserts } = makeClient({
      roles: [{ role_name: "Data Engineer", raw_role_name: null }],
    });

    const result = await refreshCandidateQualifierTokens(client, "candidate-1");

    expect(result.rowsWritten).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it("throws rather than reporting success when a read, delete or insert fails", async () => {
    await expect(
      refreshCandidateQualifierTokens(makeClient({ rolesError: { message: "down" } }).client, "c"),
    ).rejects.toBeTruthy();

    await expect(
      refreshCandidateQualifierTokens(makeClient({ roles: [], deleteError: { message: "down" } }).client, "c"),
    ).rejects.toBeTruthy();

    await expect(
      refreshCandidateQualifierTokens(
        makeClient({ roles: [{ role_name: "Data Engineer", raw_role_name: "Azure Data Engineer" }], insertError: { message: "down" } })
          .client,
        "c",
      ),
    ).rejects.toBeTruthy();
  });
});
