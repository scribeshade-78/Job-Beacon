import { describe, expect, it, vi } from "vitest";
import { TOKENIZER_VERSION } from "../../shared/evidenceTokens.js";
import {
  deriveCandidateQualifierRows,
  intentFingerprintOf,
  loadPublishedQualifierGeneration,
  refreshCandidateQualifierTokens,
} from "./candidateQualifierTokens.js";

/**
 * MOCKED CLIENT. The emitted statement ORDER and the compare-and-swap filter are
 * asserted; the tables, RLS, the composite key and REAL CONCURRENCY are not
 * exercised here. Statement ordering in a mock is not proof of concurrency
 * safety — the guard's correctness rests on the conditional UPDATE matching zero
 * rows, which only Postgres can demonstrate.
 */

describe("deriveCandidateQualifierRows", () => {
  it("keeps each qualifier attached to the canonical role it belongs to", () => {
    const rows = deriveCandidateQualifierRows([
      { roleName: "Data Engineer", rawRoleName: "Azure Data Engineer" },
      { roleName: "Teacher", rawRoleName: "Montessori Teacher" },
    ]);

    expect(rows.map((row) => [row.roleName, row.qualifier])).toEqual([
      ["Data Engineer", "azure"],
      ["Teacher", "montessori"],
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
});

describe("intentFingerprintOf", () => {
  it("is order-independent but changes with any edit, addition, removal or clear", () => {
    const a = intentFingerprintOf([{ roleName: "Data Engineer", rawRoleName: "Azure Data Engineer" }]);
    const reordered = intentFingerprintOf([
      { roleName: "Teacher", rawRoleName: null },
      { roleName: "Data Engineer", rawRoleName: "Azure Data Engineer" },
    ]);
    const withTeacher = intentFingerprintOf([
      { roleName: "Data Engineer", rawRoleName: "Azure Data Engineer" },
      { roleName: "Teacher", rawRoleName: null },
    ]);

    expect(reordered).toBe(withTeacher);
    expect(intentFingerprintOf([{ roleName: "Data Engineer", rawRoleName: null }])).not.toBe(a);
    expect(intentFingerprintOf([{ roleName: "Data Engineer", rawRoleName: "AWS Data Engineer" }])).not.toBe(a);
  });
});

interface Role {
  role_name: string;
  raw_role_name: string | null;
}

interface Config {
  roles?: Role[];
  /** Intent as it is when publication is attempted; defaults to `roles`. */
  freshRoles?: Role[];
  pointer?: { candidate_id: string; intent_fingerprint: string | null } | null;
  rolesError?: unknown;
  insertError?: unknown;
  pointerInsertError?: unknown;
  swapRows?: number;
}

function makeClient(config: Config = {}) {
  const log: string[] = [];
  const inserts: Array<Array<Record<string, unknown>>> = [];
  const swaps: Array<Array<[string, unknown]>> = [];
  let roleReads = 0;

  const from = vi.fn((table: string) => {
    if (table === "candidate_selected_roles") {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        then: (resolve: (value: unknown) => unknown) => {
          roleReads += 1;
          const rows = roleReads === 1 ? (config.roles ?? []) : (config.freshRoles ?? config.roles ?? []);
          return Promise.resolve(
            config.rolesError ? { data: null, error: config.rolesError } : { data: rows, error: null },
          ).then(resolve);
        },
      };
      return builder;
    }

    if (table === "candidate_qualifier_generations") {
      const filters: Array<[string, unknown]> = [];
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        maybeSingle: async () =>
          config.pointer === null || config.pointer === undefined
            ? { data: null, error: null }
            : {
                // A fixed id so the returned shape is assertable.
                data: { ...config.pointer, generation: "generation-1", tokenizer_version: TOKENIZER_VERSION },
                error: null,
              },
        insert: async () => {
          log.push("pointer-insert");
          return { error: config.pointerInsertError ?? null };
        },
        update: () => {
          log.push("swap");
          swaps.push(filters);
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: Array.from({ length: config.swapRows ?? 1 }, () => ({ candidate_id: "candidate-1" })),
            error: null,
          }).then(resolve),
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

  return { client: { from } as never, log, inserts, swaps };
}

const AZURE: Role[] = [{ role_name: "Data Engineer", raw_role_name: "Azure Data Engineer" }];

/** The same intent in the camelCase shape intentFingerprintOf takes. */
const AZURE_INTENT = [{ roleName: "Data Engineer", rawRoleName: "Azure Data Engineer" }];

describe("refreshCandidateQualifierTokens — publication guard", () => {
  it("publishes only after its rows exist, and reports it", async () => {
    const { client, log, inserts } = makeClient({ roles: AZURE, pointer: null });

    const result = await refreshCandidateQualifierTokens(client, "candidate-1");

    expect(result.outcome).toBe("published");
    expect(log[0]).toBe("insert");
    expect(log).toContain("pointer-insert");
    expect(inserts[0][0]).toMatchObject({
      candidate_id: "candidate-1",
      role_name: "Data Engineer",
      qualifier: "azure",
      generation: result.generation,
    });
  });

  it("REFUSES to publish a generation derived from older intent", async () => {
    // The candidate edited their preference while this refresh was working.
    const { client, log } = makeClient({
      roles: AZURE,
      freshRoles: [{ role_name: "Data Engineer", raw_role_name: "AWS Data Engineer" }],
      pointer: null,
    });

    const result = await refreshCandidateQualifierTokens(client, "candidate-1");

    expect(result.outcome).toBe("stale");
    expect(result.rowsWritten).toBe(0);
    // No pointer move at all: the newer refresh owns publication.
    expect(log).not.toContain("pointer-insert");
    expect(log).not.toContain("swap");
  });

  it("compare-and-swaps on the intent the current pointer was derived from", async () => {
    const { client, swaps } = makeClient({
      roles: AZURE,
      pointer: { candidate_id: "candidate-1", intent_fingerprint: intentFingerprintOf(AZURE_INTENT) },
    });

    const result = await refreshCandidateQualifierTokens(client, "candidate-1");

    expect(result.outcome).toBe("published");
    expect(swaps[0]).toEqual([
      ["candidate_id", "candidate-1"],
      ["intent_fingerprint", intentFingerprintOf(AZURE_INTENT)],
    ]);
  });

  it("loses the race safely when the CAS matches zero rows", async () => {
    const { client } = makeClient({
      roles: AZURE,
      pointer: { candidate_id: "candidate-1", intent_fingerprint: intentFingerprintOf(AZURE_INTENT) },
      swapRows: 0,
    });

    const result = await refreshCandidateQualifierTokens(client, "candidate-1");

    // A newer generation is current and STAYS current.
    expect(result).toEqual({
      candidateId: "candidate-1",
      rolesConsidered: 1,
      rowsWritten: 0,
      generation: result.generation,
      outcome: "stale",
    });
  });

  it("treats an unverifiable (pre-guard) pointer as replaceable rather than current", async () => {
    const { client, swaps } = makeClient({
      roles: AZURE,
      pointer: { candidate_id: "candidate-1", intent_fingerprint: null },
    });

    const result = await refreshCandidateQualifierTokens(client, "candidate-1");

    expect(result.outcome).toBe("published");
    // No fingerprint filter: one re-derivation is allowed to replace it.
    expect(swaps[0]).toEqual([["candidate_id", "candidate-1"]]);
  });

  it("never deletes before publishing, so a failed insert cannot empty the cache", async () => {
    const { client, log } = makeClient({ roles: AZURE, pointer: null, insertError: { message: "down" } });

    await expect(refreshCandidateQualifierTokens(client, "candidate-1")).rejects.toBeTruthy();

    expect(log).toEqual(["insert"]);
  });

  it("reports stale rather than throwing when another refresh published first", async () => {
    const { client } = makeClient({ roles: AZURE, pointer: null, pointerInsertError: { message: "duplicate key" } });

    const result = await refreshCandidateQualifierTokens(client, "candidate-1");

    expect(result.outcome).toBe("stale");
  });

  it("publishes an explicitly EMPTY generation, so cleared intent is not 'never derived'", async () => {
    const { client, log, inserts } = makeClient({
      roles: [{ role_name: "Data Engineer", raw_role_name: null }],
      pointer: null,
    });

    const result = await refreshCandidateQualifierTokens(client, "candidate-1");

    expect(result.rowsWritten).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(log).toContain("pointer-insert");
    expect(result.outcome).toBe("published");
  });

  it("throws on a read error rather than publishing anything", async () => {
    await expect(
      refreshCandidateQualifierTokens(makeClient({ rolesError: { message: "down" } }).client, "c"),
    ).rejects.toBeTruthy();
  });
});

describe("loadPublishedQualifierGeneration — read-time validity", () => {
  it("returns null when nothing has been published — UNKNOWN, not empty", async () => {
    expect(await loadPublishedQualifierGeneration(makeClient({ pointer: null }).client, "candidate-1")).toBeNull();
  });

  it("returns the generation when it still matches the candidate's CURRENT intent", async () => {
    const { client } = makeClient({
      roles: AZURE,
      pointer: { candidate_id: "candidate-1", intent_fingerprint: intentFingerprintOf(AZURE_INTENT) },
    });

    expect(await loadPublishedQualifierGeneration(client, "candidate-1")).toEqual({
      candidateId: "candidate-1",
      generation: "generation-1",
      tokenizerVersion: TOKENIZER_VERSION,
    });
  });

  it("treats a STALE generation as unknown, so a cleared preference stops ranking", async () => {
    // The pointer still names the old generation — publication deliberately keeps
    // the previous one current when a refresh loses a race. After the candidate
    // CLEARS their phrase, that generation no longer corresponds to anything they
    // recorded, so it must not be served as current preferences.
    const { client } = makeClient({
      roles: [{ role_name: "Data Engineer", raw_role_name: null }],
      pointer: { candidate_id: "candidate-1", intent_fingerprint: intentFingerprintOf(AZURE_INTENT) },
    });

    expect(await loadPublishedQualifierGeneration(client, "candidate-1")).toBeNull();
  });

  it("treats a pre-guard pointer with no fingerprint as unverifiable", async () => {
    const { client } = makeClient({
      roles: AZURE,
      pointer: { candidate_id: "candidate-1", intent_fingerprint: null },
    });

    expect(await loadPublishedQualifierGeneration(client, "candidate-1")).toBeNull();
  });
});
