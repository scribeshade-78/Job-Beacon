import { describe, expect, it, vi } from "vitest";
import { findActiveCandidateIds, findFitAnalysisCandidateIds } from "./activeCandidates.js";

interface InCall {
  column: string;
  values: unknown[];
}

/** Thenable chainable stub that records every in() filter. */
function builder(result: { data?: unknown; error?: unknown }, inCalls: InCall[]) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.in = (column: string, values: unknown[]) => {
    inCalls.push({ column, values });
    return b;
  };
  b.then = (resolve: (v: unknown) => void) => resolve(result);
  return b as never;
}

function makeClient(opts: { authorized?: string[]; withRoles?: string[]; confirmed?: string[] } = {}) {
  const inCalls: InCall[] = [];

  const from = vi.fn((table: string) => {
    if (table === "automation_authorizations") {
      return builder({ data: (opts.authorized ?? []).map((candidate_id) => ({ candidate_id })), error: null }, inCalls);
    }
    if (table === "candidate_selected_roles") {
      return builder({ data: (opts.withRoles ?? []).map((candidate_id) => ({ candidate_id })), error: null }, inCalls);
    }
    if (table === "fact_confirmations") {
      return builder({ data: (opts.confirmed ?? []).map((candidate_id) => ({ extracted_facts: { candidate_id } })), error: null }, inCalls);
    }
    throw new Error("unexpected table " + table);
  });

  return { client: { from } as never, from, inCalls };
}

describe("findActiveCandidateIds", () => {
  it("chunks the candidate filter, because a large authorized base exceeds the URI limit", () => {
    // PostgREST carries in() as a URL query parameter. 250 ids is about 9.8 KB of query
    // string; at a few hundred authorized candidates this function would throw
    // {"message":"URI too long"} - and it is on the AUTOMATED SUBMISSION path, not just the
    // fit paths, so the blast radius is applications that never get submitted.
    const authorized = Array.from({ length: 250 }, (_, i) => "cand-" + i);
    const { client, inCalls } = makeClient({ authorized, withRoles: authorized });

    return findActiveCandidateIds(client).then((ids) => {
      const roleFilters = inCalls.filter((call) => call.column === "candidate_id");

      expect(roleFilters.length).toBeGreaterThan(1);
      for (const call of roleFilters) {
        expect(call.values.length).toBeLessThanOrEqual(100);
      }
      // Chunking must not lose anyone: every authorized candidate holds a role here.
      expect(ids).toHaveLength(250);
    });
  });

  it("still returns only candidates that are authorized AND hold a role", async () => {
    const { client } = makeClient({
      authorized: ["cand-a", "cand-b", "cand-c"],
      withRoles: ["cand-a", "cand-c"],
    });

    expect((await findActiveCandidateIds(client)).sort()).toEqual(["cand-a", "cand-c"]);
  });

  it("does not query roles at all when nobody is authorized", async () => {
    const { client, from } = makeClient({ authorized: [] });

    expect(await findActiveCandidateIds(client)).toEqual([]);
    expect(from).not.toHaveBeenCalledWith("candidate_selected_roles");
  });
});

describe("findFitAnalysisCandidateIds", () => {
  it("unions a confirmed fact with a selected role, de-duplicated", async () => {
    const { client } = makeClient({
      confirmed: ["cand-a", "cand-b"],
      withRoles: ["cand-b", "cand-c"],
    });

    expect((await findFitAnalysisCandidateIds(client)).sort()).toEqual(["cand-a", "cand-b", "cand-c"]);
  });

  it("includes a candidate whose only signal is a confirmed fact", async () => {
    const { client } = makeClient({ confirmed: ["cand-only-facts"], withRoles: [] });

    expect(await findFitAnalysisCandidateIds(client)).toEqual(["cand-only-facts"]);
  });

  it("never reads automation_authorizations", async () => {
    // The whole point of the split: a fit score is candidate-facing output, so it must not be
    // gated on consent to ACT for the candidate.
    const { client, from } = makeClient({ confirmed: ["cand-a"], withRoles: ["cand-b"] });

    await findFitAnalysisCandidateIds(client);

    expect(from).not.toHaveBeenCalledWith("automation_authorizations");
  });
});
