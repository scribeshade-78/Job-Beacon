import { describe, expect, it, vi, beforeEach } from "vitest";

const analyzeFitMock = vi.fn();
vi.mock("./analyzeFit.js", () => ({
  analyzeFit: (...args: unknown[]) => analyzeFitMock(...args),
}));

import { runOneFitAnalysisJob } from "./fitWorker.js";

function row(over: Record<string, unknown> = {}) {
  return {
    candidate_id: "cand-1",
    vacancy_id: "vac-1",
    jd_snapshot_id: "snap-1",
    jd_text_available: true,
    technical_fit_score: 70,
    technical_fit_components: {},
    missing_evidence: [],
    practical_eligibility_score: 100,
    hard_blockers: [],
    soft_penalties: [],
    eligibility_capped: false,
    top_reasons: [],
    risks: [],
    model_version: "openai/gpt-4o-mini",
    prompt_version: "fit-analysis-v1",
    priority_score: 66,
    priority_uncapped_score: 66,
    priority_components: { technical_fit: { weight: 0.2, value: 70, source: "fit" } },
    priority_score_version: "priority-v3",
    ...over,
  };
}

function makeClient(job: Record<string, unknown> | null) {
  const updates: Array<Record<string, unknown>> = [];
  const upserts: unknown[] = [];

  const jobsBuilder = {
    update: (v: Record<string, unknown>) => {
      updates.push(v);
      return { eq: () => Promise.resolve({ error: null }) };
    },
  };
  const analysesBuilder = {
    upsert: (v: unknown) => {
      upserts.push(v);
      return Promise.resolve({ error: null });
    },
  };

  const from = vi.fn((table: string) => {
    if (table === "fit_analysis_jobs") return jobsBuilder;
    if (table === "fit_analyses") return analysesBuilder;
    throw new Error(`unexpected table ${table}`);
  });

  const rpc = vi.fn().mockResolvedValue({ data: job ? [job] : [], error: null });

  return { client: { from, rpc } as never, updates, upserts };
}

const deps = { openai: {} as never };

beforeEach(() => {
  analyzeFitMock.mockReset();
});

describe("runOneFitAnalysisJob", () => {
  it("returns processed:false when the queue is empty", async () => {
    const { client } = makeClient(null);
    const result = await runOneFitAnalysisJob(client, deps);
    expect(result).toEqual({ processed: false });
  });

  it("success: upserts fit_analyses and marks the job done", async () => {
    analyzeFitMock.mockResolvedValue(row());
    const { client, updates, upserts } = makeClient({ id: "job-1", candidate_id: "cand-1", vacancy_id: "vac-1", attempts: 1, max_attempts: 5 });

    const result = await runOneFitAnalysisJob(client, deps);

    expect(result.processed).toBe(true);
    expect(result.jobId).toBe("job-1");
    expect(upserts).toHaveLength(1);
    expect(updates[0].status).toBe("done");
  });

  it("persists the Phase 2.3b priority columns as part of the upsert", async () => {
    analyzeFitMock.mockResolvedValue(row());
    const { client, upserts } = makeClient({ id: "job-1", candidate_id: "cand-1", vacancy_id: "vac-1", attempts: 1, max_attempts: 5 });

    await runOneFitAnalysisJob(client, deps);

    expect(upserts[0]).toMatchObject({
      priority_score: 66,
      priority_uncapped_score: 66,
      priority_score_version: "priority-v3",
      priority_components: { technical_fit: { weight: 0.2, value: 70, source: "fit" } },
    });
  });

  it("failure below max_attempts: leaves job leased with a future leased_until (backoff retry)", async () => {
    analyzeFitMock.mockRejectedValue(new Error("AI malformed"));
    const { client, updates } = makeClient({ id: "job-1", candidate_id: "c", vacancy_id: "v", attempts: 2, max_attempts: 5 });

    const result = await runOneFitAnalysisJob(client, deps);

    expect(result.error).toBe("AI malformed");
    expect(updates[0].status).toBe("leased");
    expect(new Date(updates[0].leased_until as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("failure at max_attempts: dead-letters the job (status failed)", async () => {
    analyzeFitMock.mockRejectedValue(new Error("still broken"));
    const { client, updates } = makeClient({ id: "job-1", candidate_id: "c", vacancy_id: "v", attempts: 5, max_attempts: 5 });

    await runOneFitAnalysisJob(client, deps);

    expect(updates[0].status).toBe("failed");
    expect(updates[0].last_error).toBe("still broken");
  });

  it("propagates a claim RPC error (infra-level, no job to attribute)", async () => {
    const { client } = makeClient(null);
    (client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc.mockResolvedValue({ data: null, error: { message: "rpc down" } });
    await expect(runOneFitAnalysisJob(client, deps)).rejects.toBeTruthy();
  });
});
