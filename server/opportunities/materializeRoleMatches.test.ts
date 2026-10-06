import { describe, expect, it, vi } from "vitest";
import {
  BROWSEABLE_TRUST_STATUSES,
  ROLE_MATCHER_VERSION,
  loadRoleMatchCoverage,
  materializeCandidateRoleMatches,
  roleInputFingerprint,
} from "./materializeRoleMatches.js";

/**
 * MOCKED CLIENT. The emitted payloads, the keyset cursor, the corpus-version
 * gating and the publish-on-completion rule are asserted; the tables, the
 * trigger, transactions, RLS and real corpus traversal are NOT exercised. These
 * are not database or concurrency tests — the executable (UNEXECUTED) fixtures
 * live in supabase/tests/database/role_match_freshness.test.sql.
 */

interface Vacancy {
  id: string;
  raw_title: string | null;
}

interface Coverage {
  published_generation: string | null;
  running_generation: string | null;
  corpus_cursor: string | null;
  corpus_complete: boolean;
  role_input_fingerprint: string | null;
  matcher_version: string | null;
  running_corpus_version: number | null;
  published_corpus_version: number | null;
  status: string;
  scanned: number;
  matched: number;
}

interface Config {
  roles?: string[];
  coverage?: Coverage | null;
  coverageError?: { message: string } | null;
  versionError?: { message: string } | null;
  currentCorpusVersion?: number;
  batches?: Vacancy[][];
  failBatch?: number;
  publishResult?: boolean;
  publishError?: { message: string } | null;
}

function coverage(partial: Partial<Coverage> = {}): Coverage {
  return {
    published_generation: null,
    running_generation: null,
    corpus_cursor: null,
    corpus_complete: false,
    role_input_fingerprint: roleInputFingerprint([{ roleName: "Data Engineer" }]),
    matcher_version: ROLE_MATCHER_VERSION,
    running_corpus_version: null,
    published_corpus_version: null,
    status: "idle",
    scanned: 0,
    matched: 0,
    ...partial,
  };
}

function makeClient(config: Config = {}) {
  const matchUpserts: Array<Array<Record<string, unknown>>> = [];
  const coverageUpserts: Array<Record<string, unknown>> = [];
  const coverageUpdates: Array<Record<string, unknown>> = [];
  const vacancyCalls: Array<{ method: string; args: unknown[] }> = [];
  const gtCalls: Array<[string, unknown]> = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  let batchIndex = 0;

  const rpc = vi.fn(async (name: string, args?: unknown) => {
    rpcCalls.push({ name, args });

    if (name === "current_role_match_corpus_version") {
      if (config.versionError) {
        return { data: null, error: config.versionError };
      }
      return { data: config.currentCorpusVersion ?? 1, error: null };
    }

    if (name === "publish_role_match_coverage") {
      if (config.publishError) {
        return { data: null, error: config.publishError };
      }
      return { data: config.publishResult ?? true, error: null };
    }

    return { data: null, error: { message: "unexpected rpc " + name } };
  });

  const from = vi.fn((table: string) => {
    if (table === "candidate_selected_roles") {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: (config.roles ?? []).map((role_name) => ({ role_name })),
            error: null,
          }).then(resolve),
      };
      return builder;
    }

    if (table === "candidate_role_match_coverage") {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data: config.coverage ?? null,
          error: config.coverageError ?? null,
        }),
        upsert: async (row: Record<string, unknown>) => {
          coverageUpserts.push(row);
          return { error: null };
        },
        update: (row: Record<string, unknown>) => {
          coverageUpdates.push(row);
          const chain: any = {
            eq: () => chain,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve({ error: null }).then(resolve),
          };
          return chain;
        },
      };
      return builder;
    }

    if (table === "candidate_role_matches") {
      const builder: any = {
        upsert: async (rows: Array<Record<string, unknown>>) => {
          matchUpserts.push(rows);
          return { error: null };
        },
      };
      return builder;
    }

    // vacancies — the browseable corpus scan.
    const builder: any = {
      select: (...args: unknown[]) => {
        vacancyCalls.push({ method: "select", args });
        return builder;
      },
      eq: (column: string, value: unknown) => {
        vacancyCalls.push({ method: "eq", args: [column, value] });
        return builder;
      },
      in: (column: string, value: unknown) => {
        vacancyCalls.push({ method: "in", args: [column, value] });
        return builder;
      },
      order: (...args: unknown[]) => {
        vacancyCalls.push({ method: "order", args });
        return builder;
      },
      limit: (...args: unknown[]) => {
        vacancyCalls.push({ method: "limit", args });
        return builder;
      },
      gt: (column: string, value: unknown) => {
        gtCalls.push([column, value]);
        return builder;
      },
      then: (resolve: (value: unknown) => unknown) => {
        const index = batchIndex;
        batchIndex += 1;
        if (config.failBatch === index) {
          return Promise.resolve({ data: null, error: { message: "corpus unavailable" } }).then(resolve);
        }
        return Promise.resolve({ data: (config.batches ?? [])[index] ?? [], error: null }).then(resolve);
      },
    };
    return builder;
  });

  return {
    client: { from, rpc } as never,
    matchUpserts,
    coverageUpserts,
    coverageUpdates,
    vacancyCalls,
    gtCalls,
    rpcCalls,
  };
}

describe("materialisation", () => {
  it("matches only relevant browseable titles and records the exact input title", async () => {
    const { client, matchUpserts, vacancyCalls, rpcCalls } = makeClient({
      roles: ["Data Engineer"],
      currentCorpusVersion: 1,
      batches: [
        [
          { id: "v1", raw_title: "Data Engineer" },
          { id: "v2", raw_title: "Registered Nurse" },
        ],
      ],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1");

    expect(result.matched).toBe(1);
    expect(matchUpserts[0]).toEqual([
      expect.objectContaining({
        candidate_id: "candidate-1",
        role_name: "Data Engineer",
        vacancy_id: "v1",
        input_title: "Data Engineer",
        matcher_version: ROLE_MATCHER_VERSION,
        generation: result.generation,
      }),
    ]);

    // The scan is scoped to the browseable set, mirroring candidate_opportunities.
    expect(vacancyCalls).toContainEqual({ method: "eq", args: ["status", "active"] });
    expect(vacancyCalls).toContainEqual({
      method: "in",
      args: ["trust_status", [...BROWSEABLE_TRUST_STATUSES]],
    });

    // Publishing goes through the version-checked RPC, never a raw pointer write.
    expect(rpcCalls).toContainEqual({
      name: "publish_role_match_coverage",
      args: expect.objectContaining({
        p_candidate_id: "candidate-1",
        p_generation: result.generation,
        p_expected_corpus_version: 1,
      }),
    });
  });

  it("keeps qualifier-role association for a multi-role candidate", async () => {
    const { client, matchUpserts } = makeClient({
      roles: ["Data Engineer", "Teacher"],
      batches: [[{ id: "v1", raw_title: "Teacher" }]],
    });

    await materializeCandidateRoleMatches(client, "candidate-1");

    expect(matchUpserts[0]).toEqual([
      expect.objectContaining({ role_name: "Teacher", vacancy_id: "v1", input_title: "Teacher" }),
    ]);
  });

  it("scopes every write to the candidate", async () => {
    const { client, matchUpserts, coverageUpserts } = makeClient({
      roles: ["Data Engineer"],
      batches: [[{ id: "v1", raw_title: "Data Engineer" }]],
    });

    await materializeCandidateRoleMatches(client, "candidate-7");

    expect(matchUpserts[0][0].candidate_id).toBe("candidate-7");
    expect(coverageUpserts.every((row) => row.candidate_id === "candidate-7")).toBe(true);
  });

  it("resumes from the stored cursor only while the corpus version is unchanged", async () => {
    const { client, gtCalls } = makeClient({
      roles: ["Data Engineer"],
      currentCorpusVersion: 1,
      coverage: coverage({
        status: "running",
        running_generation: "gen-run",
        running_corpus_version: 1,
        corpus_cursor: "v5",
        scanned: 5,
        matched: 2,
      }),
      batches: [[{ id: "v9", raw_title: "Data Engineer" }]],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1");

    expect(result.coverageState).toBe("partial");
    expect(result.startedNewGeneration).toBe(false);
    expect(gtCalls).toEqual([["id", "v5"]]);
  });

  it("starts a NEW generation when the selected roles changed", async () => {
    const { client, gtCalls } = makeClient({
      roles: ["Teacher"],
      currentCorpusVersion: 1,
      coverage: coverage({
        status: "running",
        running_generation: "gen-run",
        running_corpus_version: 1,
        corpus_cursor: "v5",
        scanned: 5,
        matched: 2,
      }),
      batches: [[{ id: "v9", raw_title: "Teacher" }]],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1");

    expect(result.startedNewGeneration).toBe(true);
    expect(result.generation).not.toBe("gen-run");
    expect(gtCalls).toEqual([]);
  });

  it("restarts instead of resuming when a browseable insert moved the corpus version behind the cursor", async () => {
    const { client, gtCalls } = makeClient({
      roles: ["Data Engineer"],
      // The version moved AFTER the in-flight scan recorded its start version.
      currentCorpusVersion: 2,
      coverage: coverage({
        status: "running",
        running_generation: "gen-run",
        running_corpus_version: 1,
        corpus_cursor: "v5",
        scanned: 5,
        matched: 2,
      }),
      batches: [[{ id: "v1", raw_title: "Data Engineer" }]],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1");

    expect(result.coverageState).toBe("stale");
    expect(result.startedNewGeneration).toBe(true);
    // Never continues from the old cursor: the portion behind it is not proven.
    expect(gtCalls).toEqual([]);
  });

  it("publishes only when the corpus traversal COMPLETES", async () => {
    const { client, coverageUpserts, rpcCalls } = makeClient({
      roles: ["Data Engineer"],
      currentCorpusVersion: 3,
      batches: [[{ id: "v1", raw_title: "Data Engineer" }]],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1", { batchSize: 5 });

    expect(result.status).toBe("complete");
    expect(result.corpusComplete).toBe(true);
    expect(rpcCalls).toContainEqual({
      name: "publish_role_match_coverage",
      args: expect.objectContaining({
        p_generation: result.generation,
        p_expected_corpus_version: 3,
      }),
    });
    // The pointer is advanced by the RPC, never by a blind upsert.
    expect(coverageUpserts.some((row) => "published_generation" in row)).toBe(false);
  });

  it("does not publish a scan that spans a corpus change and records it for restart", async () => {
    const { client, coverageUpserts, coverageUpdates } = makeClient({
      roles: ["Data Engineer"],
      currentCorpusVersion: 1,
      publishResult: false,
      batches: [[{ id: "v1", raw_title: "Data Engineer" }]],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1");

    expect(result.status).toBe("stale");
    expect(result.corpusComplete).toBe(true);
    expect(coverageUpdates.at(-1)).toMatchObject({
      running_generation: result.generation,
      running_corpus_version: 1,
      corpus_complete: false,
      status: "running",
    });
    expect(String(coverageUpdates.at(-1)?.last_error)).toContain("corpus changed");
    expect(coverageUpserts.some((row) => "published_generation" in row)).toBe(false);
    expect(coverageUpdates.some((row) => "published_generation" in row)).toBe(false);
  });

  it("leaves the previous generation published while a scan is incomplete", async () => {
    const { client, coverageUpserts, rpcCalls } = makeClient({
      roles: ["Data Engineer"],
      // A FULL batch means the corpus may continue.
      batches: [
        [
          { id: "v1", raw_title: "Data Engineer" },
          { id: "v2", raw_title: "Data Engineer" },
        ],
      ],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1", {
      batchSize: 2,
      maxBatches: 1,
    });

    expect(result.status).toBe("running");
    expect(result.corpusComplete).toBe(false);
    expect(coverageUpserts.some((row) => "published_generation" in row)).toBe(false);
    expect(rpcCalls.some((call) => call.name === "publish_role_match_coverage")).toBe(false);
  });

  it("records a failure and publishes nothing", async () => {
    const { client, coverageUpdates, rpcCalls } = makeClient({
      roles: ["Data Engineer"],
      failBatch: 0,
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1");

    expect(result.status).toBe("failed");
    expect(result.error).toContain("corpus unavailable");
    expect(coverageUpdates.at(-1)).toMatchObject({
      status: "failed",
      corpus_complete: false,
      running_generation: result.generation,
    });
    expect(rpcCalls.some((call) => call.name === "publish_role_match_coverage")).toBe(false);
  });

  it("writes NOTHING in dry-run", async () => {
    const { client, matchUpserts, coverageUpserts, coverageUpdates } = makeClient({
      roles: ["Data Engineer"],
      batches: [[{ id: "v1", raw_title: "Data Engineer" }]],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1", { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.matched).toBe(1);
    expect(matchUpserts).toHaveLength(0);
    expect(coverageUpserts).toHaveLength(0);
    expect(coverageUpdates).toHaveLength(0);
  });

  it("is a no-op, with no writes, when the published generation is already current", async () => {
    const { client, matchUpserts, coverageUpserts, coverageUpdates, rpcCalls } = makeClient({
      roles: ["Data Engineer"],
      currentCorpusVersion: 1,
      coverage: coverage({
        status: "complete",
        corpus_complete: true,
        published_generation: "gen-1",
        published_corpus_version: 1,
      }),
      batches: [[{ id: "v1", raw_title: "Data Engineer" }]],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1");

    expect(result.status).toBe("complete");
    expect(result.coverageState).toBe("current");
    expect(result.batches).toBe(0);
    expect(matchUpserts).toHaveLength(0);
    expect(coverageUpserts).toHaveLength(0);
    expect(coverageUpdates).toHaveLength(0);
    expect(rpcCalls.some((call) => call.name === "publish_role_match_coverage")).toBe(false);
  });

  it("treats a published generation with no corpus version as legacy-unknown and rebuilds it without backfilling", async () => {
    const { client, matchUpserts } = makeClient({
      roles: ["Data Engineer"],
      currentCorpusVersion: 5,
      coverage: coverage({
        status: "complete",
        corpus_complete: true,
        published_generation: "gen-legacy",
        published_corpus_version: null,
      }),
      batches: [[{ id: "v1", raw_title: "Data Engineer" }]],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1");

    expect(result.coverageState).toBe("legacy-unknown");
    expect(result.startedNewGeneration).toBe(true);
    // The legacy generation is never rewritten, so its unknown input stays unknown.
    expect(matchUpserts[0][0].generation).not.toBe("gen-legacy");
    expect(matchUpserts[0][0].input_title).toBe("Data Engineer");
  });
});

describe("loadRoleMatchCoverage", () => {
  it("reports none when no coverage row exists", async () => {
    const { client } = makeClient({ roles: [], coverage: null });

    const result = await loadRoleMatchCoverage(client, "candidate-1");

    expect(result.state).toBe("none");
    expect(result.currentCorpusVersion).toBe(1);
  });

  it("reports current when inputs, matcher and corpus version all match", async () => {
    const { client } = makeClient({
      currentCorpusVersion: 4,
      coverage: coverage({
        status: "complete",
        corpus_complete: true,
        published_generation: "gen-1",
        published_corpus_version: 4,
      }),
    });

    const result = await loadRoleMatchCoverage(client, "candidate-1", {
      roles: [{ roleName: "Data Engineer" }],
    });

    expect(result.state).toBe("current");
    expect(result.publishedGeneration).toBe("gen-1");
  });

  it("reports stale for a published pointer without a completed traversal", async () => {
    const { client } = makeClient({
      currentCorpusVersion: 1,
      coverage: coverage({
        status: "complete",
        corpus_complete: false,
        published_generation: "gen-1",
        published_corpus_version: 1,
      }),
    });

    const result = await loadRoleMatchCoverage(client, "candidate-1", {
      roles: [{ roleName: "Data Engineer" }],
    });

    expect(result.state).toBe("stale");
  });

  it("reports stale for a corpus change that no positive match row can fingerprint", async () => {
    const { client } = makeClient({
      currentCorpusVersion: 9,
      coverage: coverage({
        status: "complete",
        corpus_complete: true,
        published_generation: "gen-1",
        published_corpus_version: 8,
      }),
    });

    const result = await loadRoleMatchCoverage(client, "candidate-1", {
      roles: [{ roleName: "Data Engineer" }],
    });

    expect(result.state).toBe("stale");
    expect(result.reason).toContain("corpus changed");
  });

  it("reports stale when the selected roles changed since publication", async () => {
    const { client } = makeClient({
      currentCorpusVersion: 1,
      coverage: coverage({
        status: "complete",
        corpus_complete: true,
        published_generation: "gen-1",
        published_corpus_version: 1,
      }),
    });

    const result = await loadRoleMatchCoverage(client, "candidate-1", {
      roles: [{ roleName: "Teacher" }],
    });

    expect(result.state).toBe("stale");
  });

  it("reports partial, and resumable, for an unchanged incomplete scan", async () => {
    const { client } = makeClient({
      currentCorpusVersion: 2,
      coverage: coverage({
        status: "running",
        running_generation: "gen-run",
        running_corpus_version: 2,
        corpus_cursor: "v5",
        scanned: 5,
        matched: 2,
      }),
    });

    const result = await loadRoleMatchCoverage(client, "candidate-1", {
      roles: [{ roleName: "Data Engineer" }],
    });

    expect(result.state).toBe("partial");
    expect(result.resumable).toBe(true);
  });

  it("reports failed when the last scan failed and nothing is published", async () => {
    const { client } = makeClient({
      coverage: coverage({
        status: "failed",
        running_generation: "gen-run",
        running_corpus_version: 1,
        corpus_cursor: "v5",
        scanned: 5,
        matched: 2,
      }),
    });

    const result = await loadRoleMatchCoverage(client, "candidate-1", {
      roles: [{ roleName: "Data Engineer" }],
    });

    expect(result.state).toBe("failed");
    // A failed scan is still resumable while its inputs and version are unchanged.
    expect(result.resumable).toBe(true);
  });

  it("reports legacy-unknown for a published generation with no recorded corpus version", async () => {
    const { client } = makeClient({
      coverage: coverage({
        status: "complete",
        corpus_complete: true,
        published_generation: "gen-legacy",
        published_corpus_version: null,
      }),
    });

    const result = await loadRoleMatchCoverage(client, "candidate-1", {
      roles: [{ roleName: "Data Engineer" }],
    });

    expect(result.state).toBe("legacy-unknown");
  });

  it("reports stale for an incomplete scan whose corpus version moved", async () => {
    const { client } = makeClient({
      currentCorpusVersion: 3,
      coverage: coverage({
        status: "running",
        running_generation: "gen-run",
        running_corpus_version: 2,
        corpus_cursor: "v5",
        scanned: 5,
        matched: 2,
      }),
    });

    const result = await loadRoleMatchCoverage(client, "candidate-1", {
      roles: [{ roleName: "Data Engineer" }],
    });

    expect(result.state).toBe("stale");
    expect(result.resumable).toBe(false);
  });

  it("surfaces a coverage query failure as an error instead of 'no coverage'", async () => {
    const { client } = makeClient({ coverageError: { message: "coverage unavailable" } });

    await expect(
      loadRoleMatchCoverage(client, "candidate-1", { roles: [{ roleName: "Data Engineer" }] }),
    ).rejects.toBeTruthy();
  });

  it("surfaces a corpus-version failure as an error instead of trusting a default", async () => {
    const { client } = makeClient({
      versionError: { message: "version unavailable" },
      coverage: null,
    });

    await expect(
      loadRoleMatchCoverage(client, "candidate-1", { roles: [{ roleName: "Data Engineer" }] }),
    ).rejects.toBeTruthy();
  });
});

describe("roleInputFingerprint", () => {
  it("is order-independent and changes when a role is added or removed", () => {
    const a = roleInputFingerprint([{ roleName: "Data Engineer" }]);
    const b = roleInputFingerprint([{ roleName: "Teacher" }, { roleName: "Data Engineer" }]);
    const c = roleInputFingerprint([{ roleName: "Data Engineer" }, { roleName: "Teacher" }]);

    expect(b).toBe(c);
    expect(a).not.toBe(b);
  });
});
