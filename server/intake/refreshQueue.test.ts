import { describe, expect, it, vi } from "vitest";
import {
  drainIntakeRefreshJobs,
  enqueueIntakeRefresh,
  readLatestIntakeRefresh,
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
  /** The row readLatestIntakeRefresh's single-row SELECT resolves to. */
  latest?: { data: unknown; error: unknown };
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
      // Chainable enough for readLatestIntakeRefresh's
      // .select(...).eq(...).order(...).limit(1).maybeSingle(). A bare await still
      // resolves the count shape the other readers expect.
      select: () => {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        builder.eq = chain;
        builder.order = chain;
        builder.limit = chain;
        builder.maybeSingle = () => Promise.resolve(opts.latest ?? { data: null, error: null });
        builder.then = (resolve: (value: unknown) => unknown) => resolve({ count: 0, error: null });
        return builder;
      },
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

/**
 * The fit batch moved here FROM THE HTTP ROUTE when that route became a 202. Scoring
 * new vacancies was never optional: an unscored vacancy carries a NULL priority score
 * and sorts below every scored row, so a refresh that fetched jobs the candidate could
 * not find would be the original bug in a new costume.
 */
describe("drainIntakeRefreshJobs — the post-refresh fit batch", () => {
  it("scores the vacancies the fan-out just created and stores the counts", async () => {
    const { client, updates } = makeClient({ claim: { data: [JOB], error: null } });
    const runFit = vi.fn(async () => ({ claimed: 2, analyzed: 2, capped: 0, noJdText: 0, failed: 0 }));
    const injected = deps({ openai: {} as never, runFit: runFit as never });

    const result = await drainIntakeRefreshJobs(client, { deps: injected });

    expect(result.processed).toBe(1);
    // Targeted at the ids the fan-out reported, not the FIFO backlog.
    expect(runFit).toHaveBeenCalledWith(
      expect.anything(),
      { openai: {} },
      expect.objectContaining({ vacancyIds: ["v1", "v2"], maxPerBatch: 5 }),
    );

    const done = updateRows(updates).find((row) => row.status === "done");
    expect(done!.result).toMatchObject({ fitAnalyzed: 2, fitPending: 0, fitError: null });
  });

  it("keeps the refresh DONE when scoring fails, recording the reason instead", async () => {
    // Best-effort by design: the vacancies are already ingested and visible, and the
    // scheduled fit drain will pick them up. Failing the whole refresh would hide the
    // jobs that were successfully fetched.
    const { client, updates } = makeClient({ claim: { data: [JOB], error: null } });
    const runFit = vi.fn(async () => {
      throw new Error("openai is down");
    });
    const injected = deps({ openai: {} as never, runFit: runFit as never });

    const result = await drainIntakeRefreshJobs(client, { deps: injected });

    expect(result.processed).toBe(1);
    const done = updateRows(updates).find((row) => row.status === "done");
    expect(done).toBeTruthy();
    expect(done!.result).toMatchObject({ received: 16, fitAnalyzed: 0, fitPending: 2 });
    expect(String((done!.result as Record<string, unknown>).fitError)).toContain("openai is down");
    expect(updateRows(updates).some((row) => row.status === "failed")).toBe(false);
  });

  it("leaves the new vacancies to the scheduled fit drain when no model client is wired", async () => {
    const { client, updates } = makeClient({ claim: { data: [JOB], error: null } });
    const runFit = vi.fn();
    const injected = deps({ runFit: runFit as never });

    await drainIntakeRefreshJobs(client, { deps: injected });

    expect(runFit).not.toHaveBeenCalled();
    const done = updateRows(updates).find((row) => row.status === "done");
    expect(done!.result).toMatchObject({ fitAnalyzed: 0, fitPending: 2 });
  });
});

/**
 * The MONITOR read. The 202 tells the candidate their press was accepted; without this
 * they have no way to learn that the background refresh finished, failed, or is still
 * going, and the button can only lie or spin.
 */
describe("readLatestIntakeRefresh", () => {
  const stored = {
    sources: [{ sourceCode: "remotive", status: "ok", received: 16, ingested: 3 }],
    received: 16,
    ingested: 3,
    created: 2,
    updated: 1,
    newVacancyIds: ["v1", "v2"],
    skippedByAdapter: 0,
    trustStatusCounts: { VERIFIED_INCOMPLETE: 3 },
    durationMs: 1234,
    failedSources: 0,
    fitAnalyzed: 2,
    fitPending: 0,
    fitStoppedOnDeadline: false,
    fitError: null,
  };

  it("returns the newest row's summary so the UI can render what the refresh found", async () => {
    const { client } = makeClient({
      latest: {
        data: { status: "done", result: stored, last_error: null, updated_at: "2026-10-15T12:00:00.000Z" },
        error: null,
      },
    });

    const status = await readLatestIntakeRefresh(client, CANDIDATE);

    expect(status).toEqual({
      status: "done",
      running: false,
      result: stored,
      lastError: null,
      updatedAt: "2026-10-15T12:00:00.000Z",
    });
  });

  it("reports a leased or pending job as running and withholds its not-yet-final result", async () => {
    const leased = makeClient({
      latest: { data: { status: "leased", result: null, last_error: null, updated_at: null }, error: null },
    });
    const pending = makeClient({
      latest: { data: { status: "pending", result: null, last_error: null, updated_at: null }, error: null },
    });

    expect(await readLatestIntakeRefresh(leased.client, CANDIDATE)).toMatchObject({ running: true });
    expect(await readLatestIntakeRefresh(pending.client, CANDIDATE)).toMatchObject({ running: true });
  });

  it("carries the stored reason when the refresh failed", async () => {
    const { client } = makeClient({
      latest: { data: { status: "failed", result: null, last_error: "jooble quota exhausted", updated_at: null }, error: null },
    });

    const status = await readLatestIntakeRefresh(client, CANDIDATE);

    expect(status.running).toBe(false);
    expect(status.result).toBeNull();
    expect(status.lastError).toBe("jooble quota exhausted");
  });

  it("answers idle when the candidate has never refreshed, rather than throwing", async () => {
    const { client } = makeClient({ latest: { data: null, error: null } });

    expect(await readLatestIntakeRefresh(client, CANDIDATE)).toEqual({
      status: "idle",
      running: false,
      result: null,
      lastError: null,
      updatedAt: null,
    });
  });

  it("throws a real read failure instead of reporting idle", async () => {
    const { client } = makeClient({ latest: { data: null, error: { message: "relation does not exist" } } });

    await expect(readLatestIntakeRefresh(client, CANDIDATE)).rejects.toThrow();
  });
});

