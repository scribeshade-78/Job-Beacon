import { describe, expect, it, vi } from "vitest";
import {
  drainIntakeRefreshJobs,
  enqueueIntakeRefresh,
  type IntakeRefreshDeps,
} from "./refreshQueue.js";

/**
 * The queue the "Fetch latest jobs" button writes to. It exists because that route used to
 * AWAIT the whole fan-out, and one of its sources is a lifetime-quota API: a request that
 * blocks is a request that times out, and the candidate is told it failed while it succeeds.
 */

const CANDIDATE = "11111111-1111-1111-1111-111111111111";

function updateRows(updates: unknown[]): Record<string, unknown>[] {
  return updates as Record<string, unknown>[];
}

function makeClient(opts: {
  insert?: { data: unknown; error: unknown };
  claim?: { data: unknown; error: unknown };
  update?: { data: unknown; error: unknown };
}) {
  const updates: unknown[] = [];
  const inserted: unknown[] = [];
  let claimCalls = 0;

  const client = {
    from: () => ({
      insert: (row: unknown) => {
        inserted.push(row);
        return {
          select: () => ({
            single: () => Promise.resolve(opts.insert ?? { data: { id: "job-1" }, error: null }),
          }),
        };
      },
      update: (row: unknown) => {
        updates.push(row);
        return { eq: () => Promise.resolve(opts.update ?? { data: null, error: null }) };
      },
      select: () => ({ eq: () => ({ eq: () => Promise.resolve({ count: 0, error: null }) }) }),
    }),
    // THE LEASE IS PART OF THE CONTRACT, so the double has to model it. A real
    // claim_intake_refresh_job leases the row for 5 minutes, so a second call inside the
    // same tick does NOT return it again. An always-returns-the-job double made the drain
    // look like it looped forever; it was the double that was wrong.
    rpc: () => {
      claimCalls += 1;
      if (claimCalls > 1) return Promise.resolve({ data: [], error: null });
      return Promise.resolve(opts.claim ?? { data: [], error: null });
    },
  };

  return { client: client as never, updates, inserted };
}

const JOB = {
  id: "job-1",
  candidate_id: CANDIDATE,
  source_codes: ["remotive"],
  search: null,
  row_limit: null,
  attempts: 1,
  max_attempts: 5,
};

const deps = (overrides: IntakeRefreshDeps = {}): IntakeRefreshDeps => ({
  loadQueryContext: vi.fn(async () => ({ keywords: "data engineer", location: "Berlin", country: "de", countries: ["de"] })),
  runIntake: vi.fn(async () => ({
    sources: [{ sourceCode: "remotive", status: "ok", received: 16, ingested: 3 }],
    newVacancyIds: ["v1", "v2"],
    received: 16,
    ingested: 3,
    created: 2,
    updated: 1,
  })) as never,
  ...overrides,
});

describe("enqueueIntakeRefresh", () => {
  it("queues the REQUEST params, not the candidate's profile", async () => {
    // The profile is deliberately not copied: a queued refresh must use the candidate's
    // CURRENT keywords when it runs, not the ones they had when they pressed the button.
    const { client, inserted } = makeClient({});

    const result = await enqueueIntakeRefresh(client, CANDIDATE, { sourceCodes: ["remotive"], search: "data", limit: 25 });

    expect(result).toEqual({ enqueued: true, alreadyRunning: false, jobId: "job-1" });
    expect(inserted[0]).toEqual({
      candidate_id: CANDIDATE,
      source_codes: ["remotive"],
      search: "data",
      row_limit: 25,
    });
    expect(JSON.stringify(inserted[0])).not.toContain("keywords");
  });

  it("reports already-running instead of stacking a second identical fan-out", async () => {
    // The partial unique index refuses a second pending/leased row for the same candidate.
    // That is a normal outcome, not an error: the caller should say "already refreshing".
    const { client } = makeClient({ insert: { data: null, error: { code: "23505", message: "duplicate key" } } });

    const result = await enqueueIntakeRefresh(client, CANDIDATE, { sourceCodes: [] });

    expect(result).toEqual({ enqueued: false, alreadyRunning: true, jobId: null });
  });

  it("still throws a real insert failure rather than reporting it as already-running", async () => {
    const { client } = makeClient({ insert: { data: null, error: { code: "42P01", message: "relation does not exist" } } });

    await expect(enqueueIntakeRefresh(client, CANDIDATE, {})).rejects.toThrow();
  });
});

describe("drainIntakeRefreshJobs", () => {
  it("claims one job, runs the fan-out, and records the summary", async () => {
    const { client, updates } = makeClient({ claim: { data: [JOB], error: null } });
    const injected = deps();

    const result = await drainIntakeRefreshJobs(client, { maxJobs: 5, deps: injected });

    expect(result.processed).toBe(1);
    expect(injected.runIntake).toHaveBeenCalledTimes(1);
    const done = updateRows(updates).find((row) => row.status === "done");
    expect(done).toBeTruthy();
    expect(done!.result).toMatchObject({ received: 16, ingested: 3 });
  });

  it("passes the stored source filter and the FRESH profile context to the fan-out", async () => {
    const { client } = makeClient({ claim: { data: [JOB], error: null } });
    const injected = deps();

    await drainIntakeRefreshJobs(client, { deps: injected });

    const call = vi.mocked(injected.runIntake!).mock.calls[0]!;
    expect(call[1]).toMatchObject({
      sourceCodes: ["remotive"],
      keywords: "data engineer",
      location: "Berlin",
      country: "de",
    });
  });

  it("marks the job failed with the error and does not throw, so one bad refresh cannot end the tick", async () => {
    const { client, updates } = makeClient({ claim: { data: [JOB], error: null } });
    const injected = deps({ runIntake: vi.fn(async () => { throw new Error("jooble is down"); }) as never });

    const result = await drainIntakeRefreshJobs(client, { deps: injected });

    expect(result.processed).toBe(1);
    const failed = updateRows(updates).find((row) => row.status === "failed");
    expect(failed).toBeTruthy();
    expect(String(failed!.last_error)).toContain("jooble is down");
    expect(updateRows(updates).some((row) => row.result !== undefined)).toBe(false);
  });

  it("stops on an empty queue rather than spinning", async () => {
    const { client } = makeClient({ claim: { data: [], error: null } });
    const result = await drainIntakeRefreshJobs(client, { deps: deps() });
    expect(result).toEqual({ processed: 0, stoppedOnDeadline: false });
  });

  it("stops at the deadline BEFORE claiming more work", async () => {
    const { client } = makeClient({ claim: { data: [JOB], error: null } });
    const injected = deps();
    let tick = 0;
    const now = () => new Date(1_000_000 + (tick += 10_000));

    const result = await drainIntakeRefreshJobs(client, { deadlineMs: 5_000, deps: injected, now });

    expect(result.stoppedOnDeadline).toBe(true);
    expect(result.processed).toBe(0);
    expect(injected.runIntake).not.toHaveBeenCalled();
  });
});
