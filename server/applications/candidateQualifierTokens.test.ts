import { describe, expect, it, vi } from "vitest";
import { TOKENIZER_VERSION } from "../../shared/evidenceTokens.js";
import {
  deriveCandidateQualifierRows,
  loadPublishedQualifierGeneration,
  refreshCandidateQualifierTokens,
} from "./candidateQualifierTokens.js";

/**
 * MOCKED CLIENT, NOT DATABASE VALIDATION: the derivation is pure and asserted
 * directly, and publication is asserted as the ORDER of emitted statements. The
 * tables, their RLS policies, the composite key and real concurrency are NOT
 * exercised by anything here.
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
  insertError?: unknown;
  pointerError?: unknown;
}

function makeClient(config: Config = {}) {
  /** Ordered log of the statements that matter, so publication ORDER is assertable. */
  const log: string[] = [];
  const inserts: Array<Array<Record<string, unknown>>> = [];
  const pointers: Array<Record<string, unknown>> = [];

  const from = vi.fn((table: string) => {
    if (table === "candidate_selected_roles") {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(
            config.rolesError ? { data: null, error: config.rolesError } : { data: config.roles ?? [], error: null },
          ).then(resolve),
      };
      return builder;
    }

    if (table === "candidate_qualifier_generations") {
      const builder: any = {
        upsert: async (row: Record<string, unknown>) => {
          log.push("publish");
          pointers.push(row);
          return { error: config.pointerError ?? null };
        },
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () =>
          pointers.length === 0
            ? { data: null, error: null }
            : {
                data: {
                  candidate_id: pointers[0].candidate_id,
                  generation: pointers[0].generation,
                  tokenizer_version: pointers[0].tokenizer_version,
                },
                error: null,
              },
      };
      return builder;
    }

    const builder: any = {
      insert: async (rows: Array<Record<string, unknown>>) => {
        log.push("insert");
        inserts.push(rows);
        return { error: config.insertError ?? null };
      },
      delete: () => {
        log.push("cleanup");
        return builder;
      },
      eq: () => builder,
      neq: () => builder,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return builder;
  });

  return { client: { from } as never, log, inserts, pointers };
}

describe("refreshCandidateQualifierTokens — staged publication", () => {
  it("writes the new generation and publishes it AFTER the rows exist", async () => {
    const { client, log, inserts, pointers } = makeClient({
      roles: [{ role_name: "Data Engineer", raw_role_name: "Azure Data Engineer" }],
    });

    const result = await refreshCandidateQualifierTokens(client, "candidate-1");

    // The order is the fix: rows first, pointer second, cleanup last.
    expect(log).toEqual(["insert", "publish", "cleanup"]);
    expect(inserts[0][0]).toMatchObject({
      candidate_id: "candidate-1",
      role_name: "Data Engineer",
      qualifier: "azure",
      tokenizer_version: TOKENIZER_VERSION,
      generation: result.generation,
    });
    expect(pointers[0]).toMatchObject({
      candidate_id: "candidate-1",
      generation: result.generation,
      tokenizer_version: TOKENIZER_VERSION,
    });
    expect(result).toEqual({
      candidateId: "candidate-1",
      rolesConsidered: 1,
      rowsWritten: 1,
      generation: result.generation,
    });
  });

  it("NEVER deletes before publishing, so a failed insert cannot empty the cache", async () => {
    const { client, log } = makeClient({
      roles: [{ role_name: "Data Engineer", raw_role_name: "Azure Data Engineer" }],
      insertError: { message: "tokens unavailable" },
    });

    await expect(refreshCandidateQualifierTokens(client, "candidate-1")).rejects.toBeTruthy();

    // No publish and no cleanup: the previously published generation is still
    // what readers see, rather than a candidate left with no preferences.
    expect(log).toEqual(["insert"]);
  });

  it("does not publish when the pointer write fails", async () => {
    const { client } = makeClient({
      roles: [{ role_name: "Data Engineer", raw_role_name: "Azure Data Engineer" }],
      pointerError: { message: "pointer unavailable" },
    });

    await expect(refreshCandidateQualifierTokens(client, "candidate-1")).rejects.toBeTruthy();
  });

  it("publishes an explicitly EMPTY generation, so cleared intent is not 'never derived'", async () => {
    const { client, log, inserts, pointers } = makeClient({
      roles: [{ role_name: "Data Engineer", raw_role_name: null }],
    });

    const result = await refreshCandidateQualifierTokens(client, "candidate-1");

    expect(result.rowsWritten).toBe(0);
    expect(inserts).toHaveLength(0);
    // The pointer still advances: confirmed-empty is distinguishable from a
    // failure, and from a candidate who has never been derived.
    expect(log).toContain("publish");
    expect(pointers).toHaveLength(1);
  });

  it("throws on a read error rather than publishing anything", async () => {
    await expect(
      refreshCandidateQualifierTokens(makeClient({ rolesError: { message: "down" } }).client, "c"),
    ).rejects.toBeTruthy();
  });
});

describe("loadPublishedQualifierGeneration", () => {
  it("returns null when nothing has been published — UNKNOWN, not empty", async () => {
    const { client } = makeClient({ roles: [] });

    expect(await loadPublishedQualifierGeneration(client, "candidate-1")).toBeNull();
  });

  it("returns the published generation after a refresh", async () => {
    const { client } = makeClient({
      roles: [{ role_name: "Data Engineer", raw_role_name: "Azure Data Engineer" }],
    });

    const refresh = await refreshCandidateQualifierTokens(client, "candidate-1");
    const published = await loadPublishedQualifierGeneration(client, "candidate-1");

    expect(published).toEqual({
      candidateId: "candidate-1",
      generation: refresh.generation,
      tokenizerVersion: TOKENIZER_VERSION,
    });
  });
});
