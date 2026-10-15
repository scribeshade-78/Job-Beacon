import { describe, expect, it, vi } from "vitest";
import { enqueueFitJobsForVacancy } from "./enqueue.js";

/** Thenable chainable builder — every method returns `this`, awaiting resolves to `result`. */
function builder(result: { data?: unknown; error?: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const b: Record<string, unknown> = { calls };
  for (const m of ["select", "eq", "in", "upsert"]) {
    b[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => void) => resolve(result);
  return b as never;
}

function makeClient(opts: {
  confirmedFactCandidates?: string[];
  withRoles?: string[];
  upsertError?: unknown;
}) {
  // The two fit signals, NOT the automation gate: automation_authorizations is deliberately
  // absent from this dispatch, so a query against it throws "unexpected table" rather than
  // silently passing.
  const factsBuilder = builder({
    data: (opts.confirmedFactCandidates ?? []).map((id) => ({ extracted_facts: { candidate_id: id } })),
    error: null,
  });
  const rolesBuilder = builder({ data: (opts.withRoles ?? []).map((id) => ({ candidate_id: id })), error: null });
  const jobsBuilder = builder({ error: opts.upsertError ?? null });

  const from = vi.fn((table: string) => {
    if (table === "fact_confirmations") return factsBuilder;
    if (table === "candidate_selected_roles") return rolesBuilder;
    if (table === "fit_analysis_jobs") return jobsBuilder;
    throw new Error(`unexpected table ${table}`);
  });

  return { client: { from } as never, from, jobsBuilder };
}

describe("enqueueFitJobsForVacancy", () => {
  it("upserts one job per candidate with a FIT signal, unioning confirmed facts and roles", async () => {
    const { client, jobsBuilder } = makeClient({
      confirmedFactCandidates: ["cand-a", "cand-b"],
      withRoles: ["cand-b", "cand-c"],
    });

    const result = await enqueueFitJobsForVacancy(client, "vac-1");

    // The union, de-duplicated: cand-b is in both sets and appears once.
    expect(result).toEqual({ enqueued: 3 });
    const upsertCall = (jobsBuilder as unknown as { calls: Array<{ method: string; args: unknown[] }> }).calls.find(
      (c) => c.method === "upsert",
    )!;
    const rows = upsertCall.args[0] as Array<{ candidate_id: string; vacancy_id: string; status: string; attempts: number }>;
    expect(rows.map((r) => r.candidate_id).sort()).toEqual(["cand-a", "cand-b", "cand-c"]);
    expect(rows.every((r) => r.vacancy_id === "vac-1" && r.status === "pending" && r.attempts === 0)).toBe(true);
    expect(upsertCall.args[1]).toEqual({ onConflict: "candidate_id,vacancy_id" });
  });

  it("does not consult automation_authorizations, so a candidate who never opted in is still scored", async () => {
    // fit_analyses is a candidate-facing read surface, so the enqueue must not be gated on
    // automation consent - that gate decides who the system may ACT for. The DB triggers
    // never had it, and this is the TypeScript side agreeing with them.
    const { client, from } = makeClient({ confirmedFactCandidates: ["cand-a"], withRoles: [] });

    await enqueueFitJobsForVacancy(client, "vac-1");

    expect(from).not.toHaveBeenCalledWith("automation_authorizations");
  });

  it("writes nothing when no candidate has a fit signal", async () => {
    const { client, from } = makeClient({ confirmedFactCandidates: [], withRoles: [] });
    const result = await enqueueFitJobsForVacancy(client, "vac-1");
    expect(result).toEqual({ enqueued: 0 });
    expect(from).not.toHaveBeenCalledWith("fit_analysis_jobs");
  });

  it("throws when the upsert fails", async () => {
    const { client } = makeClient({ confirmedFactCandidates: ["cand-a"], withRoles: [], upsertError: { message: "boom" } });
    await expect(enqueueFitJobsForVacancy(client, "vac-1")).rejects.toBeTruthy();
  });
});
