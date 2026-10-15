import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueIngestionBatch, runIngestionBatch } from "./runner.js";
import { runOneIngestionJob } from "./worker.js";
// The real allow-list the scheduled pull will pass, imported rather than retyped so this
// test cannot pass against a list that has drifted from the one Step 6 will use.
import { KEYLESS_SCHEDULED_SOURCE_CODES } from "../opportunities/scheduledRefresh.js";

vi.mock("./worker.js", () => ({
  runOneIngestionJob: vi.fn(),
}));

const mockedRunOneJob = vi.mocked(runOneIngestionJob);

// vitest.config.ts sets no clearMocks/restoreMocks, so the module-level mock
// (and its queued mockResolvedValueOnce results) would otherwise leak between
// tests in this file.
beforeEach(() => {
  mockedRunOneJob.mockReset();
});

interface Target {
  id: string;
  source_code: string;
  target_key: string;
}

interface HealthWrite {
  vacancy_source_id: string | null;
  status: "success" | "error";
  vacancies_fetched: number;
  error_message: string | null;
}

/**
 * Queue-based thenable double: every from(table) hands back a fresh chainable
 * builder whose await pops the next queued response for that table. The
 * runner queries source_health_events twice per call (per-target cooldown
 * lookup, then post-drain attribution) and ingestion_jobs twice per target
 * (pending check, then insert), so a single fixed response per table — the
 * shape the other suites' doubles use — cannot express it.
 */
function tableDouble(responses: Array<{ data?: unknown; error?: unknown }>) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let index = 0;

  return {
    calls,
    from: () => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "gte", "in", "order", "limit", "insert"]) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ method, args });
          return builder;
        };
      }
      builder.then = (resolve: (value: unknown) => void) => {
        const response = responses[Math.min(index, responses.length - 1)] ?? { data: null, error: null };
        index += 1;
        return resolve(response);
      };
      return builder;
    },
  };
}

function makeClient(options: {
  targets: Target[];
  /** Most recent health event inside the cooldown window, per target id. */
  recentByTarget?: Record<string, { status: "success" | "error"; error_message?: string | null; vacancies_fetched?: number }>;
  hasPendingByTarget?: Record<string, boolean>;
  /** Health rows the worker "wrote" during this batch. */
  healthWrites?: HealthWrite[];
}) {
  const sources = tableDouble([{ data: options.targets, error: null }]);

  // Cooldown lookups happen in target order, but only for targets that reach
  // that point (a target skipped by cooldown returns before the pending
  // check), so the pending-job queue is built against the same subset.
  const cooldownResponses: Array<{ data: unknown; error: unknown }> = [];
  const pendingResponses: Array<{ data: unknown; error: unknown }> = [];

  for (const target of options.targets) {
    const recent = options.recentByTarget?.[target.id];
    cooldownResponses.push({
      data: recent
        ? [{ vacancy_source_id: target.id, status: recent.status, vacancies_fetched: recent.vacancies_fetched ?? 0, error_message: recent.error_message ?? null, run_at: new Date().toISOString() }]
        : [],
      error: null,
    });

    if (!recent) {
      pendingResponses.push({
        data: (options.hasPendingByTarget?.[target.id] ?? false) ? [{ id: "job-existing" }] : [],
        error: null,
      });
    }
  }

  const health = tableDouble([
    ...cooldownResponses,
    { data: options.healthWrites ?? [], error: null },
  ]);
  const jobs = tableDouble([...pendingResponses, { data: null, error: null }]);

  const from = vi.fn((table: string) => {
    if (table === "vacancy_sources") return sources.from();
    if (table === "source_health_events") return health.from();
    if (table === "ingestion_jobs") return jobs.from();
    throw new Error(`Unexpected table: ${table}`);
  });

  return { client: { from } as never, from, sources, health, jobs };
}

const JOOBLE: Target = { id: "vs-jooble", source_code: "jooble", target_key: "us-data-engineer" };
const USAJOBS: Target = { id: "vs-usajobs", source_code: "usajobs", target_key: "us-data-engineer" };
const REMOTIVE: Target = { id: "vs-remotive", source_code: "remotive", target_key: "remote" };

function insertedSourceIds(jobs: ReturnType<typeof makeClient>["jobs"]): string[] {
  const insert = jobs.calls.find((call) => call.method === "insert");
  if (!insert) return [];
  return (insert.args[0] as Array<{ source_code: string }>).map((row) => row.source_code);
}

describe("runIngestionBatch", () => {
  it("enqueues one job per enabled target, drains, and attributes the worker's own evidence", async () => {
    mockedRunOneJob
      .mockResolvedValueOnce({ processed: true, vacanciesFetched: 50 })
      .mockResolvedValueOnce({ processed: true, vacanciesFetched: 25 })
      .mockResolvedValueOnce({ processed: false });

    const { client, jobs } = makeClient({
      targets: [JOOBLE, USAJOBS],
      healthWrites: [
        { vacancy_source_id: JOOBLE.id, status: "success", vacancies_fetched: 50, error_message: null },
        { vacancy_source_id: USAJOBS.id, status: "success", vacancies_fetched: 25, error_message: null },
      ],
    });

    const result = await runIngestionBatch(client);

    expect(insertedSourceIds(jobs)).toEqual(["jooble", "usajobs"]);
    expect(result.targets).toEqual([
      { sourceCode: "jooble", targetKey: "us-data-engineer", status: "fetched", vacanciesFetched: 50 },
      { sourceCode: "usajobs", targetKey: "us-data-engineer", status: "fetched", vacanciesFetched: 25 },
    ]);
    expect(result.vacanciesFetched).toBe(75);
    expect(result.failed).toBe(0);
  });

  it("skips a target whose last run is inside the cooldown, and spends no request on it", async () => {
    const { client, jobs, from } = makeClient({
      targets: [JOOBLE],
      recentByTarget: { [JOOBLE.id]: { status: "success", vacancies_fetched: 50 } },
    });

    const result = await runIngestionBatch(client);

    expect(jobs.calls.some((call) => call.method === "insert")).toBe(false);
    expect(from).not.toHaveBeenCalledWith("ingestion_jobs");
    expect(mockedRunOneJob).not.toHaveBeenCalled();
    expect(result.skippedRecent).toBe(1);
    expect(result.targets[0]).toEqual({
      sourceCode: "jooble",
      targetKey: "us-data-engineer",
      status: "skipped_recent",
      vacanciesFetched: 0,
    });
  });

  it("reports the last error when the cooldown is holding back a failing target", async () => {
    const { client } = makeClient({
      targets: [USAJOBS],
      recentByTarget: { [USAJOBS.id]: { status: "error", error_message: "USAJOBS discovery failed: HTTP 401" } },
    });

    const result = await runIngestionBatch(client);

    expect(result.targets[0].status).toBe("skipped_recent");
    expect(result.targets[0].lastError).toBe("USAJOBS discovery failed: HTTP 401");
  });

  it("does not stack a second job on a target that already has one queued", async () => {
    const { client, jobs } = makeClient({
      targets: [JOOBLE],
      hasPendingByTarget: { [JOOBLE.id]: true },
    });

    const result = await runIngestionBatch(client);

    expect(jobs.calls.some((call) => call.method === "insert")).toBe(false);
    expect(result.skippedQueued).toBe(1);
    expect(result.targets[0].status).toBe("skipped_queued");
  });

  it("returns an empty result without touching the queue when no target is enabled", async () => {
    const { client, from } = makeClient({ targets: [] });

    const result = await runIngestionBatch(client);

    expect(result).toEqual({
      targets: [],
      // Additive with the enqueue/drain split: the same call now reports how many targets
      // it QUEUED as well as how many it skipped.
      enqueued: 0,
      vacanciesFetched: 0,
      failed: 0,
      skippedRecent: 0,
      skippedQueued: 0,
    });
    expect(from).toHaveBeenCalledTimes(1);
    expect(mockedRunOneJob).not.toHaveBeenCalled();
  });

  it("reports a failed fetch as failed rather than silently as zero jobs", async () => {
    mockedRunOneJob.mockResolvedValueOnce({ processed: true, error: "Ada adapter exploded" }).mockResolvedValueOnce({ processed: false });

    const { client } = makeClient({
      targets: [JOOBLE],
      healthWrites: [
        { vacancy_source_id: JOOBLE.id, status: "error", vacancies_fetched: 0, error_message: "Ada adapter exploded" },
      ],
    });

    const result = await runIngestionBatch(client);

    expect(result.targets[0].status).toBe("failed");
    expect(result.targets[0].lastError).toBe("Ada adapter exploded");
    expect(result.failed).toBe(1);
    expect(result.vacanciesFetched).toBe(0);
  });

  it("does not claim a fetch when the job was queued but never ran", async () => {
    // maxJobs caps the drain, so the second target's job stays queued and
    // writes no health row. Reporting it as fetched would be a lie.
    mockedRunOneJob.mockResolvedValueOnce({ processed: true, vacanciesFetched: 50 });

    const { client } = makeClient({
      targets: [JOOBLE, USAJOBS],
      healthWrites: [
        { vacancy_source_id: JOOBLE.id, status: "success", vacancies_fetched: 50, error_message: null },
      ],
    });

    const result = await runIngestionBatch(client, { maxJobs: 1 });

    const usajobs = result.targets.find((target) => target.sourceCode === "usajobs")!;
    expect(usajobs.status).toBe("skipped_queued");
    expect(usajobs.vacanciesFetched).toBe(0);
    expect(result.vacanciesFetched).toBe(50);
  });

  it("scopes the cooldown lookup to the configured window, not a hardcoded one", async () => {
    // The window is applied by the database (.gte on run_at), so what the
    // runner can actually get wrong is the bound it sends. Asserting the
    // computed instant — rather than trusting the default — is the part of
    // this that a unit test can honestly pin.
    const fixedNow = new Date("2026-09-17T12:00:00.000Z");
    mockedRunOneJob.mockResolvedValueOnce({ processed: false });

    const { client, health } = makeClient({ targets: [JOOBLE] });

    await runIngestionBatch(client, { minIntervalMinutes: 30, now: () => fixedNow });

    const gte = health.calls.find((call) => call.method === "gte")!;
    expect(gte.args[0]).toBe("run_at");
    expect(gte.args[1]).toBe("2026-09-17T11:30:00.000Z");
  });
});

describe("enqueueIngestionBatch — the asynchronous half", () => {
  // THE WHOLE POINT OF THE SPLIT. The HTTP route must return before any third-party
  // fetch happens. A real Stripe board of 726 postings took 392s through the synchronous
  // path (measured, scripts/discovery-live.ts); no proxy, gateway or browser holds a
  // request that long, so the candidate saw a failure while the work actually succeeded.

  it("enqueues the work and processes NONE of it", async () => {
    const { client, jobs } = makeClient({ targets: [JOOBLE, USAJOBS] });

    const result = await enqueueIngestionBatch(client);

    expect(insertedSourceIds(jobs)).toEqual(["jooble", "usajobs"]);
    expect(mockedRunOneJob).not.toHaveBeenCalled();
    expect(result.enqueued).toBe(2);
  });

  it("still refuses to stack a second job on a target that already has one", async () => {
    const { client, jobs } = makeClient({
      targets: [JOOBLE],
      hasPendingByTarget: { [JOOBLE.id]: true },
    });

    const result = await enqueueIngestionBatch(client);

    expect(jobs.calls.some((call) => call.method === "insert")).toBe(false);
    expect(result.skippedQueued).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(mockedRunOneJob).not.toHaveBeenCalled();
  });

  it("still honours the per-target cooldown, so the quota guard survives the refactor", async () => {
    // Jooble's free plan is a lifetime 500-request quota. The cooldown is the only thing
    // standing between a candidate-pressable button and that allowance, and it must not
    // be lost while the drain is being moved off the request path.
    const { client, jobs } = makeClient({
      targets: [JOOBLE],
      recentByTarget: { [JOOBLE.id]: { status: "success", vacancies_fetched: 50 } },
    });

    const result = await enqueueIngestionBatch(client);

    expect(jobs.calls.some((call) => call.method === "insert")).toBe(false);
    expect(result.skippedRecent).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(mockedRunOneJob).not.toHaveBeenCalled();
  });

  it("reports no work rather than failing when nothing is enqueueable", async () => {
    const { client } = makeClient({ targets: [] });
    const result = await enqueueIngestionBatch(client);
    expect(result.enqueued).toBe(0);
    expect(result.targets).toEqual([]);
  });

  /**
   * THE SOURCE FILTER (Step 6 prerequisite). The scheduled pull must be able to say
   * "only these sources", because the unattended path spends third-party quota and
   * Jooble's free plan is a LIFETIME 500 requests.
   */
  it("restricts the batch to the named sources, never touching an excluded one", async () => {
    const { client, jobs, from } = makeClient({ targets: [JOOBLE, USAJOBS] });

    const result = await enqueueIngestionBatch(client, { sourceCodes: ["usajobs"] });

    expect(insertedSourceIds(jobs)).toEqual(["usajobs"]);
    expect(result.enqueued).toBe(1);
    expect(result.targets.map((target) => target.sourceCode)).toEqual(["usajobs"]);
    // Excluded BEFORE any per-target work: no cooldown lookup, no pending-job lookup.
    expect(from.mock.calls.filter((call) => call[0] === "source_health_events")).toHaveLength(1);
  });

  it("keeps Jooble out when restricted to the keyless scheduled sources", async () => {
    // The exact call Step 6 will make. Jooble is enabled in vacancy_sources and would be
    // enqueued by an unfiltered batch; the allow-list is what keeps its lifetime quota
    // out of the unattended path.
    const { client, jobs } = makeClient({ targets: [JOOBLE, USAJOBS, REMOTIVE] });

    const result = await enqueueIngestionBatch(client, { sourceCodes: KEYLESS_SCHEDULED_SOURCE_CODES });

    expect(insertedSourceIds(jobs)).toEqual(["remotive"]);
    expect(result.enqueued).toBe(1);
    expect(KEYLESS_SCHEDULED_SOURCE_CODES).not.toContain("jooble");
  });

  it("treats an explicitly EMPTY source list as nothing-is-allowed", async () => {
    // Deliberately the opposite of the intake fan-out's empty case. There an empty list
    // means "no preference"; here the parameter is a guard, so a caller that computed an
    // empty allow-list must enqueue nothing rather than fall back to the whole table -
    // a fallback would put every quota-bearing source back on the scheduled path.
    const { client, from } = makeClient({ targets: [JOOBLE, USAJOBS] });

    const result = await enqueueIngestionBatch(client, { sourceCodes: [] });

    expect(result.enqueued).toBe(0);
    expect(result.targets).toEqual([]);
    expect(from.mock.calls.filter((call) => call[0] === "source_health_events")).toHaveLength(0);
  });

  it("still enqueues every enabled target when no filter is given", async () => {
    const { client, jobs } = makeClient({ targets: [JOOBLE, USAJOBS] });

    const result = await enqueueIngestionBatch(client);

    expect(insertedSourceIds(jobs)).toEqual(["jooble", "usajobs"]);
    expect(result.enqueued).toBe(2);
  });
});
