import { describe, expect, it, vi } from "vitest";
import { reconcileFitAnalyses } from "./reconcile.js";
import { PRIORITY_SCORE_VERSION } from "../../shared/priorityScore.js";

/**
 * Thenable chainable stub — select/eq/in all return `this`.
 *
 * `inCalls` records every .in() filter so a test can assert on the SIZE of the id lists,
 * which is what the URI limit is a function of. Optional, so the other tables' stubs are
 * unaffected.
 */
function tableStub(
  result: { data: unknown; error?: unknown },
  inCalls?: Array<{ column: string; values: unknown[] }>,
) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.in = (column: string, values: unknown[]) => {
    inCalls?.push({ column, values });
    return b;
  };
  b.then = (resolve: (v: unknown) => void) => resolve({ error: null, ...result });
  return b;
}

interface ClientOpts {
  confirmedFactCandidates?: string[];
  withRoles?: string[];
  vacancies?: string[];
  existing?: unknown[];
  vacancyError?: unknown;
  existingError?: unknown;
  upsertError?: unknown;
}

function makeClient(opts: ClientOpts = {}) {
  const upserts: unknown[][] = [];
  const fitAnalysisInCalls: Array<{ column: string; values: unknown[] }> = [];

  const from = vi.fn((table: string) => {
    // The two fit signals. automation_authorizations is deliberately NOT dispatched here, so
    // a query against it throws "unexpected table" instead of quietly passing.
    if (table === "fact_confirmations") {
      return tableStub({
        data: (opts.confirmedFactCandidates ?? []).map((candidate_id) => ({ extracted_facts: { candidate_id } })),
      });
    }
    if (table === "candidate_selected_roles") {
      return tableStub({ data: (opts.withRoles ?? []).map((candidate_id) => ({ candidate_id })) });
    }
    if (table === "vacancies") {
      return tableStub({
        data: opts.vacancyError ? null : (opts.vacancies ?? []).map((id) => ({ id })),
        error: opts.vacancyError ?? null,
      });
    }
    if (table === "fit_analyses") {
      return tableStub(
        {
          data: opts.existingError ? null : opts.existing ?? [],
          error: opts.existingError ?? null,
        },
        fitAnalysisInCalls,
      );
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

  return { client: { from } as never, from, upserts, fitAnalysisInCalls };
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
    const { client, upserts } = makeClient({ confirmedFactCandidates: [] });
    const result = await reconcileFitAnalyses(client);

    expect(result).toMatchObject({ candidates: 0, enqueued: 0, scanned: 0 });
    expect(upserts).toHaveLength(0);
  });

  it("enqueues nothing when no vacancy is verified and active", async () => {
    const { client, upserts } = makeClient({ confirmedFactCandidates: ["cand-1"], vacancies: [] });
    const result = await reconcileFitAnalyses(client);

    expect(result).toMatchObject({ candidates: 1, vacancies: 0, enqueued: 0 });
    expect(upserts).toHaveLength(0);
  });

  it("enqueues a pair that has no fit_analyses row at all", async () => {
    const { client, upserts } = makeClient({
      confirmedFactCandidates: ["cand-1"],
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
      confirmedFactCandidates: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [scored("cand-1", "vac-1", { priority_score: null, priority_score_version: null })],
    });

    const result = await reconcileFitAnalyses(client);

    expect(result.enqueued).toBe(1);
    expect(upserts[0]).toHaveLength(1);
  });

  it("enqueues a row scored under an older score version", async () => {
    const { client } = makeClient({
      confirmedFactCandidates: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [scored("cand-1", "vac-1", { priority_score_version: "priority-v2" })],
    });

    const result = await reconcileFitAnalyses(client);
    expect(result.enqueued).toBe(1);
  });

  it("skips a row already scored at the current version", async () => {
    const { client, upserts } = makeClient({
      confirmedFactCandidates: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [scored("cand-1", "vac-1")],
    });

    const result = await reconcileFitAnalyses(client);

    expect(result).toMatchObject({ scanned: 1, enqueued: 0, skipped: 1 });
    expect(upserts).toHaveLength(0);
  });

  it("treats a score of 0 as scored, not as missing", async () => {
    const { client } = makeClient({
      confirmedFactCandidates: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [scored("cand-1", "vac-1", { priority_score: 0 })],
    });

    const result = await reconcileFitAnalyses(client);
    expect(result.skipped).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  it("fans out across every active candidate x verified vacancy pair", async () => {
    const { client, upserts } = makeClient({
      confirmedFactCandidates: ["cand-1", "cand-2"],
      vacancies: ["vac-1", "vac-2", "vac-3"],
      existing: [scored("cand-1", "vac-2")],
    });

    const result = await reconcileFitAnalyses(client);

    expect(result).toMatchObject({ candidates: 2, vacancies: 3, scanned: 6, skipped: 1, enqueued: 5 });
    expect(upserts[0]).toHaveLength(5);
  });

  it("stops at the limit and reports truncated", async () => {
    const { client, upserts } = makeClient({
      confirmedFactCandidates: ["cand-1", "cand-2"],
      vacancies: ["vac-1", "vac-2", "vac-3"],
      existing: [],
    });

    const result = await reconcileFitAnalyses(client, { limit: 2 });

    expect(result).toMatchObject({ enqueued: 2, truncated: true });
    expect(upserts[0]).toHaveLength(2);
  });

  it("unions candidates with a confirmed fact and candidates with a selected role", async () => {
    const { client } = makeClient({
      confirmedFactCandidates: ["cand-1", "cand-2"],
      withRoles: ["cand-2", "cand-3"],
      vacancies: ["vac-1"],
      existing: [],
    });

    const result = await reconcileFitAnalyses(client);

    // A de-duplicated union: 3 distinct candidates, not 4 and not the intersection.
    expect(result.candidates).toBe(3);
    expect(result.enqueued).toBe(3);
  });

  it("does not consult automation_authorizations at all", async () => {
    // The consent gate governs acting FOR a candidate. Gating the back-fill on it stranded
    // every candidate who had not authorized automation at the 200-vacancy fan-out cap,
    // because this pass is the only thing that ever fills the tail.
    const { client, from } = makeClient({
      confirmedFactCandidates: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [],
    });

    await reconcileFitAnalyses(client);

    expect(from).not.toHaveBeenCalledWith("automation_authorizations");
  });

  it("chunks the fit_analyses read so a large catalogue cannot exceed the URI limit", async () => {
    // MEASURED against the real database: 743 eligible vacancies produced a ~28.9 KB
    // .in(vacancy_id, ...) filter and the gateway answered {"message":"URI too long"}, so
    // this pass threw outright and the back-fill never ran at all. The identical read
    // chunked at 100 succeeded. PostgREST carries .in() in the URL, so the id list is a
    // URI-length problem, not a page-size preference.
    const vacancies = Array.from({ length: 250 }, (_, i) => "vac-" + i);
    const { client, fitAnalysisInCalls } = makeClient({
      confirmedFactCandidates: ["cand-1"],
      vacancies,
      existing: [],
    });

    const result = await reconcileFitAnalyses(client);

    const vacancyFilters = fitAnalysisInCalls.filter((call) => call.column === "vacancy_id");
    expect(vacancyFilters.length).toBeGreaterThan(1);
    for (const call of vacancyFilters) {
      expect(call.values.length).toBeLessThanOrEqual(100);
    }

    // Chunking must not lose a pair: all 250 are still examined and enqueued.
    expect(result.scanned).toBe(250);
    expect(result.enqueued).toBe(250);
  });

  it("chunks the candidate filter too, which is the other half of the same URI", async () => {
    const candidates = Array.from({ length: 250 }, (_, i) => "cand-" + i);
    const { client, fitAnalysisInCalls } = makeClient({
      confirmedFactCandidates: candidates,
      withRoles: candidates,
      vacancies: ["vac-1"],
      existing: [],
    });

    await reconcileFitAnalyses(client, { limit: 1 });

    const candidateFilters = fitAnalysisInCalls.filter((call) => call.column === "candidate_id");
    expect(candidateFilters.length).toBeGreaterThan(1);
    for (const call of candidateFilters) {
      expect(call.values.length).toBeLessThanOrEqual(100);
    }
  });

  it("propagates a vacancy query failure", async () => {
    const { client } = makeClient({
      confirmedFactCandidates: ["cand-1"],
      vacancyError: { message: "vacancies down" },
    });

    await expect(reconcileFitAnalyses(client)).rejects.toBeTruthy();
  });

  it("propagates a fit_analyses query failure", async () => {
    const { client } = makeClient({
      confirmedFactCandidates: ["cand-1"],
      vacancies: ["vac-1"],
      existingError: { message: "fit_analyses down" },
    });

    await expect(reconcileFitAnalyses(client)).rejects.toBeTruthy();
  });

  it("propagates an enqueue failure rather than reporting success", async () => {
    const { client } = makeClient({
      confirmedFactCandidates: ["cand-1"],
      vacancies: ["vac-1"],
      existing: [],
      upsertError: { message: "queue down" },
    });

    await expect(reconcileFitAnalyses(client)).rejects.toBeTruthy();
  });
});
