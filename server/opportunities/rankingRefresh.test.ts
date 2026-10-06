import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runRankingRefresh,
  type RankingRefreshDeps,
} from "./rankingRefresh.js";

/**
 * MOCKED CLIENT AND INJECTED COLLABORATORS. This exercises the COORDINATION the
 * route owns — lease claiming, bounded continuation, failure recording and the
 * "never publish a partial sweep as complete" rule. The tokenizer, indexer and
 * matcher have their own suites; the database lease RPCs are verified only by the
 * UNEXECUTED fixture. These are not database or concurrency tests.
 */

interface RefreshRow {
  candidate_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  leased_until: string | null;
}

const IDLE_ROW: RefreshRow = {
  candidate_id: "c-1",
  status: "idle",
  attempts: 0,
  max_attempts: 5,
  last_error: null,
  leased_until: null,
};

interface Config {
  state?: () => string;
  evidenceComplete?: () => boolean;
  refreshRow?: RefreshRow | null;
  claimRefresh?: RefreshRow[] | null;
  indexClaim?: { cursor_offset: number } | null;
}

function makeClient(config: Config = {}) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const row = config.refreshRow === undefined ? IDLE_ROW : config.refreshRow;

  const rpc = vi.fn(async (name: string, args?: unknown) => {
    rpcCalls.push({ name, args });

    switch (name) {
      case "candidate_ranking_state":
        return { data: config.state ? config.state() : "current", error: null };
      case "candidate_ranking_identity":
        return { data: "identity-1", error: null };
      case "posting_evidence_complete":
        return { data: config.evidenceComplete ? config.evidenceComplete() : true, error: null };
      case "request_candidate_ranking_refresh":
        return { data: [row], error: null };
      case "claim_candidate_ranking_refresh":
        return {
          data: config.claimRefresh === undefined ? [row] : (config.claimRefresh ?? []),
          error: null,
        };
      case "claim_posting_evidence_index":
        return {
          data: config.indexClaim === null ? [] : [config.indexClaim ?? { cursor_offset: 0 }],
          error: null,
        };
      case "advance_posting_evidence_index":
        return { data: [{ cursor_offset: 0 }], error: null };
      case "finish_candidate_ranking_refresh":
        return { data: [row], error: null };
      default:
        return { data: null, error: { message: "unexpected rpc " + name } };
    }
  });

  const from = vi.fn((table: string) => {
    if (table === "candidate_ranking_refresh") {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: config.refreshRow ?? null, error: null }),
      };
      return builder;
    }

    throw new Error("unexpected table " + table);
  });

  return { client: { rpc, from } as never, rpcCalls };
}

function makeDeps(overrides: Partial<RankingRefreshDeps> = {}): RankingRefreshDeps {
  return {
    indexEvidence: vi.fn(async () => ({
      dryRun: false,
      tokenizerVersion: "evidence-tokens-v1",
      examined: 3,
      indexed: 3,
      wouldIndex: 0,
      skippedCurrent: 0,
      titleOnly: 0,
      failures: [],
      nextOffset: 0,
      done: true,
    })),
    refreshQualifiers: vi.fn(async () => ({
      candidateId: "c-1",
      rolesConsidered: 1,
      rowsWritten: 1,
      generation: "g",
      outcome: "published" as const,
    })),
    materializeMatches: vi.fn(async () => ({
      candidateId: "c-1",
      dryRun: false,
      roles: ["Data Engineer"],
      generation: "gen-1",
      coverageState: "none" as const,
      corpusVersion: 1,
      corpusComplete: true,
      batches: 1,
      scanned: 1,
      matched: 1,
      startedNewGeneration: true,
      status: "complete" as const,
    })),
    ...overrides,
  } as RankingRefreshDeps;
}

function finishCalls(rpcCalls: Array<{ name: string; args: unknown }>) {
  return rpcCalls.filter((call) => call.name === "finish_candidate_ranking_refresh").map((call) => call.args);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runRankingRefresh", () => {
  it("coordinates shared evidence indexing, qualifier derivation and role matches to completion", async () => {
    let stateReads = 0;
    let evidenceReads = 0;

    const { client, rpcCalls } = makeClient({
      state: () => (stateReads++ === 0 ? "updating" : "current"),
      evidenceComplete: () => evidenceReads++ > 0,
    });
    const deps = makeDeps();

    const result = await runRankingRefresh(client, "c-1", { deps });

    expect(result.outcome).toBe("succeeded");
    expect(result.state).toBe("current");
    expect(result.identity).toBe("identity-1");

    // Posting evidence is indexed FIRST, then candidate data.
    expect(deps.indexEvidence).toHaveBeenCalledTimes(1);
    expect(deps.refreshQualifiers).toHaveBeenCalledWith(client, "c-1");
    expect(deps.materializeMatches).toHaveBeenCalledTimes(1);

    expect(finishCalls(rpcCalls).at(-1)).toMatchObject({ p_status: "succeeded", p_last_error: null });
  });

  it("continues a multi-batch materialisation across bounded invocations instead of waiting for an operator", async () => {
    let clock = 0;

    const { client, rpcCalls } = makeClient({ state: () => "updating", evidenceComplete: () => true });
    const runningResult = {
      candidateId: "c-1",
      dryRun: false,
      roles: ["Data Engineer"],
      generation: "gen-1",
      coverageState: "partial" as const,
      corpusVersion: 1,
      corpusComplete: false,
      batches: 1,
      scanned: 1,
      matched: 0,
      startedNewGeneration: false,
      status: "running" as const,
    };
    const materializeMatches = vi.fn(async () => {
      clock += 6_000;
      return runningResult;
    });

    const result = await runRankingRefresh(client, "c-1", {
      deadlineMs: 10_000,
      now: () => clock,
      deps: makeDeps({ materializeMatches: materializeMatches as never }),
    });

    expect(result.outcome).toBe("running");
    expect(result.phase).toBe("matching");
    // Two bounded batches ran, then the deadline stopped the loop.
    expect(materializeMatches).toHaveBeenCalledTimes(2);
    expect(finishCalls(rpcCalls).at(-1)).toMatchObject({ p_status: "pending" });
  });

  it("does no duplicate work when another request holds the candidate lease", async () => {
    const { client } = makeClient({
      state: () => "updating",
      refreshRow: { ...IDLE_ROW, status: "running", leased_until: "2999-01-01T00:00:00Z" },
      claimRefresh: [],
    });
    const deps = makeDeps();

    const result = await runRankingRefresh(client, "c-1", { deps });

    expect(result.outcome).toBe("running");
    expect(deps.indexEvidence).not.toHaveBeenCalled();
    expect(deps.refreshQualifiers).not.toHaveBeenCalled();
    expect(deps.materializeMatches).not.toHaveBeenCalled();
  });

  it("does not auto-force a failed refresh, so ordinary polling cannot retry it in a loop", async () => {
    const { client, rpcCalls } = makeClient({
      state: () => "updating",
      refreshRow: { ...IDLE_ROW, status: "failed", attempts: 1, last_error: "boom" },
      claimRefresh: [],
    });
    const deps = makeDeps();

    const result = await runRankingRefresh(client, "c-1", { deps });

    expect(result.outcome).toBe("failed");
    expect(result.retryable).toBe(true);
    const requested = rpcCalls.find((call) => call.name === "request_candidate_ranking_refresh");
    expect(requested?.args).toMatchObject({ p_force: false });
    expect(deps.materializeMatches).not.toHaveBeenCalled();
  });

  it("explicit force re-arms a failed refresh", async () => {
    const { client, rpcCalls } = makeClient({
      state: () => "updating",
      refreshRow: { ...IDLE_ROW, status: "failed", attempts: 1, last_error: "boom" },
    });
    const deps = makeDeps();

    const result = await runRankingRefresh(client, "c-1", { force: true, deps });

    expect(result.outcome).toBe("succeeded");
    const requested = rpcCalls.find((call) => call.name === "request_candidate_ranking_refresh");
    expect(requested?.args).toMatchObject({ p_force: true });
  });

  it("treats a candidate with no target roles as neutral and never sweeps the shared corpus", async () => {
    const { client, rpcCalls } = makeClient({ state: () => "no_target_roles" });
    const deps = makeDeps();

    const result = await runRankingRefresh(client, "c-1", { deps });

    expect(result.outcome).toBe("no_target_roles");
    expect(deps.indexEvidence).not.toHaveBeenCalled();
    expect(deps.refreshQualifiers).not.toHaveBeenCalled();
    expect(deps.materializeMatches).not.toHaveBeenCalled();
    expect(rpcCalls.some((call) => call.name === "request_candidate_ranking_refresh")).toBe(false);
  });

  it("records an actionable failure and publishes NO partial derivation as complete", async () => {
    const { client, rpcCalls } = makeClient({ state: () => "updating", evidenceComplete: () => true });
    const deps = makeDeps({
      refreshQualifiers: vi.fn(async () => {
        throw new Error("qualifier derivation exploded");
      }) as never,
    });

    const result = await runRankingRefresh(client, "c-1", { deps });

    expect(result.outcome).toBe("failed");
    expect(result.lastError).toContain("qualifier derivation exploded");
    expect(result.retryable).toBe(true);
    expect(deps.materializeMatches).not.toHaveBeenCalled();
    expect(finishCalls(rpcCalls).at(-1)).toMatchObject({
      p_status: "failed",
      p_last_error: "qualifier derivation exploded",
    });
  });

  it("never contacts an external provider or submits anything", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    let stateReads = 0;
    let evidenceReads = 0;
    const { client } = makeClient({
      state: () => (stateReads++ === 0 ? "updating" : "current"),
      evidenceComplete: () => evidenceReads++ > 0,
    });

    await runRankingRefresh(client, "c-1", { deps: makeDeps() });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
