import { describe, expect, it, vi } from "vitest";
import {
  describeRankingRefresh,
  requestRankingRefresh,
  runRankingRefresh,
  type RankingRefreshResult,
} from "./feedRankingRefresh";

/**
 * The polling loop is bounded, backs off, and NEVER forces after the first call.
 * fetch is injected, so this is a client-boundary test, not a browser test.
 */

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const RUNNING: RankingRefreshResult = {
  outcome: "running",
  phase: "indexing",
  state: "updating",
  identity: "id-1",
  attempts: 0,
  retryable: true,
  lastError: null,
  deadlineReached: false,
};

const SUCCEEDED: RankingRefreshResult = { ...RUNNING, outcome: "succeeded", phase: "matching" };

function deps(fetchImpl: typeof fetch) {
  return { fetchImpl, getAccessToken: async () => "token" };
}

describe("requestRankingRefresh", () => {
  it("returns the workflow result on success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, SUCCEEDED)) as unknown as typeof fetch;
    const result = await requestRankingRefresh(deps(fetchImpl), true);

    expect(result.kind).toBe("success");
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ force: true });
  });

  it("treats 401 as a non-retryable session expiry", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch;
    const result = await requestRankingRefresh(deps(fetchImpl));

    expect(result).toMatchObject({ kind: "error", retryable: false });
  });

  it("treats 429 as retryable rather than a hard failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, {})) as unknown as typeof fetch;
    const result = await requestRankingRefresh(deps(fetchImpl));

    expect(result).toMatchObject({ kind: "error", retryable: true });
  });
});

describe("runRankingRefresh", () => {
  it("polls until the workflow settles", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => jsonResponse(200, call++ === 0 ? RUNNING : SUCCEEDED)) as unknown as typeof fetch;
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });

    const run = await runRankingRefresh({ ...deps(fetchImpl), now: () => clock, sleep });

    expect(run.kind).toBe("done");
    if (run.kind === "done") {
      expect(run.result.outcome).toBe("succeeded");
    }
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("forces only the FIRST call and never re-arms on a continuation poll", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => jsonResponse(200, call++ === 0 ? RUNNING : SUCCEEDED)) as unknown as typeof fetch;
    const bodies: Array<{ force: boolean }> = [];
    const wrapped = vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { force: boolean });
      return (fetchImpl as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });

    await runRankingRefresh({ ...deps(wrapped), force: true, now: () => clock, sleep });

    expect(bodies).toEqual([{ force: true }, { force: false }]);
  });

  it("stops without polling when the caller aborts (unmount)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, RUNNING)) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();

    const run = await runRankingRefresh({ ...deps(fetchImpl), signal: controller.signal });

    expect(run.kind).toBe("error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops at the local cap instead of polling forever", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, RUNNING)) as unknown as typeof fetch;
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });

    const run = await runRankingRefresh({
      ...deps(fetchImpl),
      maxDurationMs: 4_000,
      now: () => clock,
      sleep,
    });

    expect(run.kind).toBe("timeout");
    // Bounded: nowhere near an unbounded loop.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("reports a terminal workflow failure as a retryable result, not a thrown error", async () => {
    const failed: RankingRefreshResult = {
      ...RUNNING,
      outcome: "failed",
      retryable: true,
      lastError: "db down",
    };
    const fetchImpl = vi.fn(async () => jsonResponse(200, failed)) as unknown as typeof fetch;

    const run = await runRankingRefresh({ ...deps(fetchImpl) });

    expect(run.kind).toBe("done");
    if (run.kind === "done") {
      expect(run.result.outcome).toBe("failed");
      expect(run.result.retryable).toBe(true);
    }
  });
});

describe("describeRankingRefresh", () => {
  it("names progress, success, the neutral case and a failure", () => {
    expect(describeRankingRefresh(RUNNING)).toContain("posting evidence");
    expect(describeRankingRefresh(SUCCEEDED)).toContain("up to date");
    expect(describeRankingRefresh({ ...RUNNING, outcome: "no_target_roles" })).toContain("target roles");
    expect(describeRankingRefresh({ ...RUNNING, outcome: "failed", lastError: "db down" })).toContain("db down");
  });
});
