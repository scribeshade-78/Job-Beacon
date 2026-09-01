import { describe, expect, it, vi } from "vitest";
import { reconcileFitAnalyses } from "./reconcile.js";
import { PRIORITY_SCORE_VERSION } from "../../shared/priorityScore.js";

/** Thenable chainable stub — select/eq/in all return `this`. */
function tableStub(result: { data: unknown; error?: unknown }) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in"]) {
    b[m] = () => b;
  }
  b.then = (resolve: (v: unknown) => void) => resolve({ error: null, ...result });
  return b;
}

interface ClientOpts {
  authorized?: string[];
  withRoles?: string[];
  vacancies?: string[];
  existing?: unknown[];
  vacancyError?: unknown;
  existingError?: unknown;
  upsertError?: unknown;
}

function makeClient(opts: ClientOpts = {}) {
  const upserts: unknown[][] = [];

  const from = vi.fn((table: string) => {
    if (table === "automation_authorizations") {
      return tableStub({ data: (opts.authorized ?? []).map((candidate_id) => ({ candidate_id })) });
    }
    if (table === "candidate_selected_roles") {
      return tableStub({ data: (opts.withRoles ?? opts.authorized ?? []).map((candidate_id) => ({ candidate_id })) });
    }
    if (table === "vacancies") {
      return tableStub({
        data: opts.vacancyError ? null : (opts.vacancies ?? []).map((id) => ({ id })),
        error: opts.vacancyError ?? null,
      });
    }
    if (table === "fit_analyses") {
      return tableStub({
        data: opts.existingError ? null : opts.existing ?? [],
        error: opts.existingError ?? null,
      });
    }
    if (table === "fit_analysis_jobs") {
      return {
        upsert: (rows: unknown[]) => {
          upserts.push(rows);
          return Promise.resolve({ error: opts.upsertError ?? null });
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { client: { from } as never, upserts };
}

function scored(candidate_id: string, vacancy_id: string, over: Record<string, unknown> = {}) {
  return {
    candidate_id,
    vacancy_id,
    priority_score: 70,
    priority_score_version: PRIORITY_SCORE_VERSION,
    ...over,
  };
}

describe("reconcileFitAnalyses", () => {
  it("enqueues nothing when there are no active candidates", async () => {
    const { client, upserts } = makeClient({ authorized: [] });
    const result = await reconcileFitAnalyses(client);

    expect(result).toMatchObject({ candidates: 0, enqueued: 0, scanned: 0 });
    expect(upserts).toHaveLength(0);
  });

  it("enqueues nothing when no vacancy is verified and active", async () => {
    const { client, upserts } = makeClient({ authorized: ["cand-1"], vacancies: [] });
    const result = await reconcileFitAnalyses(client);

    expect(result).toMatchObject({ candidates: 1, vacancies: 0, enqueued: 0 });
    expect(upserts).toHaveLength(0);
  });

  it("enqueues a pair that has no fit_analyses row at all", async () => {
    const { client, upserts } = makeClient({
      authorized: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [],
    });

    const result = await reconcileFitAnalyses(client);

    expect(result).toMatchObject({ scanned: 1, enqueued: 1, skipped: 0, truncated: false });
    expect(upserts[0]).toEqual([
      expect.objectContaining({ candidate_id: "cand-1", vacancy_id: "vac-1", status: "pending", attempts: 0 }),
    ]);
  });

  it("enqueues a row whose priority_score is null (the 2.3b backfill gap)", async () => {
    const { client, upserts } = makeClient({
      authorized: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [scored("cand-1", "vac-1", { priority_score: null, priority_score_version: null })],
    });

    const result = await reconcileFitAnalyses(client);

    expect(result.enqueued).toBe(1);
    expect(upserts[0]).toHaveLength(1);
  });

  it("enqueues a row scored under an older score version", async () => {
    const { client } = makeClient({
      authorized: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [scored("cand-1", "vac-1", { priority_score_version: "priority-v2" })],
    });

    const result = await reconcileFitAnalyses(client);
    expect(result.enqueued).toBe(1);
  });

  it("skips a row already scored at the current version", async () => {
    const { client, upserts } = makeClient({
      authorized: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [scored("cand-1", "vac-1")],
    });

    const result = await reconcileFitAnalyses(client);

    expect(result).toMatchObject({ scanned: 1, enqueued: 0, skipped: 1 });
    expect(upserts).toHaveLength(0);
  });

  it("treats a score of 0 as scored, not as missing", async () => {
    const { client } = makeClient({
      authorized: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [scored("cand-1", "vac-1", { priority_score: 0 })],
    });

    const result = await reconcileFitAnalyses(client);
    expect(result.skipped).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  it("fans out across every active candidate x verified vacancy pair", async () => {
    const { client, upserts } = makeClient({
      authorized: ["cand-1", "cand-2"],
      vacancies: ["vac-1", "vac-2", "vac-3"],
      existing: [scored("cand-1", "vac-2")],
    });

    const result = await reconcileFitAnalyses(client);

    expect(result).toMatchObject({ candidates: 2, vacancies: 3, scanned: 6, skipped: 1, enqueued: 5 });
    expect(upserts[0]).toHaveLength(5);
  });

  it("stops at the limit and reports truncated", async () => {
    const { client, upserts } = makeClient({
      authorized: ["cand-1", "cand-2"],
      vacancies: ["vac-1", "vac-2", "vac-3"],
      existing: [],
    });

    const result = await reconcileFitAnalyses(client, { limit: 2 });

    expect(result).toMatchObject({ enqueued: 2, truncated: true });
    expect(upserts[0]).toHaveLength(2);
  });

  it("only counts candidates who are authorized AND have a selected role", async () => {
    const { client } = makeClient({
      authorized: ["cand-1", "cand-2"],
      withRoles: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [],
    });

    const result = await reconcileFitAnalyses(client);

    expect(result.candidates).toBe(1);
    expect(result.enqueued).toBe(1);
  });

  it("propagates a vacancy query failure", async () => {
    const { client } = makeClient({
      authorized: ["cand-1"],
      vacancyError: { message: "vacancies down" },
    });

    await expect(reconcileFitAnalyses(client)).rejects.toBeTruthy();
  });

  it("propagates a fit_analyses query failure", async () => {
    const { client } = makeClient({
      authorized: ["cand-1"],
      vacancies: ["vac-1"],
      existingError: { message: "fit_analyses down" },
    });

    await expect(reconcileFitAnalyses(client)).rejects.toBeTruthy();
  });

  it("propagates an enqueue failure rather than reporting success", async () => {
    const { client } = makeClient({
      authorized: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [],
      upsertError: { message: "queue down" },
    });

    await expect(reconcileFitAnalyses(client)).rejects.toBeTruthy();
  });
});
