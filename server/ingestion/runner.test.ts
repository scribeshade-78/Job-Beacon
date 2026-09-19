import { beforeEach, describe, expect, it, vi } from "vitest";
import { runIngestionBatch } from "./runner.js";
import { runOneIngestionJob } from "./worker.js";

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
