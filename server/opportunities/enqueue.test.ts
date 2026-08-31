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
  authorized?: string[];
  withRoles?: string[];
  upsertError?: unknown;
}) {
  const authBuilder = builder({ data: (opts.authorized ?? []).map((id) => ({ candidate_id: id })), error: null });
  const rolesBuilder = builder({ data: (opts.withRoles ?? []).map((id) => ({ candidate_id: id })), error: null });
  const jobsBuilder = builder({ error: opts.upsertError ?? null });

  const from = vi.fn((table: string) => {
    if (table === "automation_authorizations") return authBuilder;
    if (table === "candidate_selected_roles") return rolesBuilder;
    if (table === "fit_analysis_jobs") return jobsBuilder;
    throw new Error(`unexpected table ${table}`);
  });

  return { client: { from } as never, from, jobsBuilder };
}

describe("enqueueFitJobsForVacancy", () => {
  it("upserts one job per active candidate (authorized AND has a selected role)", async () => {
    const { client, jobsBuilder } = makeClient({
      authorized: ["cand-a", "cand-b", "cand-c"],
      withRoles: ["cand-a", "cand-c"],
    });

    const result = await enqueueFitJobsForVacancy(client, "vac-1");

    expect(result).toEqual({ enqueued: 2 });
    const upsertCall = (jobsBuilder as unknown as { calls: Array<{ method: string; args: unknown[] }> }).calls.find(
      (c) => c.method === "upsert",
    )!;
    const rows = upsertCall.args[0] as Array<{ candidate_id: string; vacancy_id: string; status: string; attempts: number }>;
    expect(rows.map((r) => r.candidate_id).sort()).toEqual(["cand-a", "cand-c"]);
    expect(rows.every((r) => r.vacancy_id === "vac-1" && r.status === "pending" && r.attempts === 0)).toBe(true);
    expect(upsertCall.args[1]).toEqual({ onConflict: "candidate_id,vacancy_id" });
  });

  it("writes nothing when there are no active candidates", async () => {
    const { client, from } = makeClient({ authorized: ["cand-a"], withRoles: [] });
    const result = await enqueueFitJobsForVacancy(client, "vac-1");
    expect(result).toEqual({ enqueued: 0 });
    expect(from).not.toHaveBeenCalledWith("fit_analysis_jobs");
  });

  it("throws when the upsert fails", async () => {
    const { client } = makeClient({ authorized: ["cand-a"], withRoles: ["cand-a"], upsertError: { message: "boom" } });
    await expect(enqueueFitJobsForVacancy(client, "vac-1")).rejects.toBeTruthy();
  });
});
