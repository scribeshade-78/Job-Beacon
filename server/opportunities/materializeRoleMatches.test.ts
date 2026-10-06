import { describe, expect, it, vi } from "vitest";
import {
  ROLE_MATCHER_VERSION,
  materializeCandidateRoleMatches,
  roleInputFingerprint,
} from "./materializeRoleMatches.js";

/**
 * MOCKED CLIENT. The emitted payloads, the keyset cursor and the publish-on-
 * completion rule are asserted; the tables, RLS and real corpus traversal are
 * NOT exercised. These are not database or concurrency tests.
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
  matcher_version: string;
  status: string;
  scanned: number;
  matched: number;
}

interface Config {
  roles?: string[];
  coverage?: Coverage | null;
  batches?: Vacancy[][];
  failBatch?: number;
}

const RUNNING_COVERAGE: Coverage = {
  published_generation: "gen-old",
  running_generation: "gen-run",
  corpus_cursor: "v5",
  corpus_complete: false,
  role_input_fingerprint: roleInputFingerprint([{ roleName: "Data Engineer" }]),
  matcher_version: ROLE_MATCHER_VERSION,
  status: "running",
  scanned: 5,
  matched: 2,
};

function makeClient(config: Config = {}) {
  const matchUpserts: Array<Array<Record<string, unknown>>> = [];
  const coverageUpserts: Array<Record<string, unknown>> = [];
  const vacancyFilters: Array<Array<[string, unknown]>> = [];
  let batchIndex = 0;

  const from = vi.fn((table: string) => {
    if (table === "candidate_selected_roles") {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: (config.roles ?? []).map((role_name) => ({ role_name })), error: null }).then(resolve),
      };
      return builder;
    }

    if (table === "candidate_role_match_coverage") {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: config.coverage ?? null, error: null }),
        upsert: async (row: Record<string, unknown>) => {
          coverageUpserts.push(row);
          return { error: null };
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

    // vacancies
    const filters: Array<[string, unknown]> = [];
    vacancyFilters.push(filters);
    const builder: any = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      gt: (column: string, value: unknown) => {
        filters.push([column, value]);
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

  return { client: { from } as never, matchUpserts, coverageUpserts, vacancyFilters };
}

describe("materialisation", () => {
  it("matches only relevant titles, using the authoritative matcher", async () => {
    const { client, matchUpserts } = makeClient({
      roles: ["Data Engineer"],
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
      expect.objectContaining({ candidate_id: "candidate-1", role_name: "Data Engineer", vacancy_id: "v1" }),
    ]);
  });

  it("keeps qualifier-role association for a multi-role candidate", async () => {
    const { client, matchUpserts } = makeClient({
      roles: ["Data Engineer", "Teacher"],
      batches: [[{ id: "v1", raw_title: "Teacher" }]],
    });

    await materializeCandidateRoleMatches(client, "candidate-1");

    expect(matchUpserts[0]).toEqual([
      expect.objectContaining({ role_name: "Teacher", vacancy_id: "v1" }),
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

  it("resumes from the stored keyset cursor when inputs still match", async () => {
    const { client, vacancyFilters } = makeClient({
      roles: ["Data Engineer"],
      coverage: RUNNING_COVERAGE,
      batches: [[{ id: "v9", raw_title: "Data Engineer" }]],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1");

    expect(result.startedNewGeneration).toBe(false);
    expect(vacancyFilters[0]).toEqual([["id", "v5"]]);
  });

  it("starts a NEW generation when the selected roles changed", async () => {
    const { client } = makeClient({
      roles: ["Teacher"],
      coverage: RUNNING_COVERAGE,
      batches: [[{ id: "v9", raw_title: "Teacher" }]],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1");

    expect(result.startedNewGeneration).toBe(true);
    expect(result.generation).not.toBe("gen-run");
  });

  it("publishes only when the corpus traversal COMPLETES", async () => {
    const { client, coverageUpserts } = makeClient({
      roles: ["Data Engineer"],
      batches: [[{ id: "v1", raw_title: "Data Engineer" }]],
      options: undefined,
    } as never);

    const result = await materializeCandidateRoleMatches(client, "candidate-1", { batchSize: 5 });

    expect(result.status).toBe("complete");
    expect(result.corpusComplete).toBe(true);
    const published = coverageUpserts.find((row) => row.published_generation !== undefined);
    expect(published?.published_generation).toBe(result.generation);
  });

  it("leaves the previous generation published while a scan is incomplete", async () => {
    const { client, coverageUpserts } = makeClient({
      roles: ["Data Engineer"],
      // A FULL batch means the corpus may continue.
      batches: [
        [
          { id: "v1", raw_title: "Data Engineer" },
          { id: "v2", raw_title: "Data Engineer" },
        ],
      ],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1", { batchSize: 2, maxBatches: 1 });

    expect(result.status).toBe("running");
    expect(result.corpusComplete).toBe(false);
    expect(coverageUpserts.some((row) => row.published_generation !== undefined)).toBe(false);
  });

  it("records a failure and publishes nothing", async () => {
    const { client, coverageUpserts } = makeClient({
      roles: ["Data Engineer"],
      failBatch: 0,
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1");

    expect(result.status).toBe("failed");
    expect(result.error).toContain("corpus unavailable");
    expect(coverageUpserts.at(-1)).toMatchObject({ status: "failed", corpus_complete: false });
    expect(coverageUpserts.some((row) => row.published_generation !== undefined)).toBe(false);
  });

  it("writes NOTHING in dry-run", async () => {
    const { client, matchUpserts, coverageUpserts } = makeClient({
      roles: ["Data Engineer"],
      batches: [[{ id: "v1", raw_title: "Data Engineer" }]],
    });

    const result = await materializeCandidateRoleMatches(client, "candidate-1", { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.matched).toBe(1);
    expect(matchUpserts).toHaveLength(0);
    expect(coverageUpserts).toHaveLength(0);
  });

  it("is safe to re-run once coverage is complete", async () => {
    const complete: Coverage = {
      ...RUNNING_COVERAGE,
      status: "complete",
      corpus_complete: true,
      published_generation: "gen-run",
    };
    const { client } = makeClient({
      roles: ["Data Engineer"],
      coverage: complete,
      batches: [[{ id: "v1", raw_title: "Data Engineer" }]],
    });

    const first = await materializeCandidateRoleMatches(client, "candidate-1");
    expect(first.status).toBe("complete");
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
