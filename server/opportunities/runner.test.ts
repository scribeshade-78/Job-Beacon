import { describe, expect, it, vi, beforeEach } from "vitest";

const runOneMock = vi.fn();
vi.mock("./fitWorker.js", () => ({
  runOneFitAnalysisJob: (...args: unknown[]) => runOneMock(...args),
}));

import { runFitAnalysisBatch } from "./runner.js";

const client = {} as never;
const deps = { openai: {} as never };

beforeEach(() => runOneMock.mockReset());

describe("runFitAnalysisBatch", () => {
  it("drains until processed:false and tallies outcomes", async () => {
    runOneMock
      .mockResolvedValueOnce({ processed: true, jobId: "a", capped: false, jdTextAvailable: true })
      .mockResolvedValueOnce({ processed: true, jobId: "b", capped: true, jdTextAvailable: true })
      .mockResolvedValueOnce({ processed: true, jobId: "c", jdTextAvailable: false })
      .mockResolvedValueOnce({ processed: true, jobId: "d", error: "boom" })
      .mockResolvedValueOnce({ processed: false });

    const result = await runFitAnalysisBatch(client, deps);

    expect(result).toEqual({ claimed: 4, analyzed: 3, capped: 1, noJdText: 1, failed: 1 });
  });

  it("respects maxPerBatch", async () => {
    runOneMock.mockResolvedValue({ processed: true, jobId: "x", jdTextAvailable: true });
    const result = await runFitAnalysisBatch(client, deps, { maxPerBatch: 3 });
    expect(result.claimed).toBe(3);
    expect(runOneMock).toHaveBeenCalledTimes(3);
  });

  it("stops the drain and reports claimError if the claim RPC throws", async () => {
    runOneMock.mockRejectedValueOnce(new Error("rpc down"));
    const result = await runFitAnalysisBatch(client, deps);
    expect(result.claimError).toBe("rpc down");
    expect(result.claimed).toBe(0);
  });
});
