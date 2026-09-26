import { describe, expect, it, vi } from "vitest";
import {
  DEAD_LETTER_LIMIT,
  getQueueSummary,
  isQueueName,
  listQueues,
  QUEUE_NAMES,
  rearmFailedJob,
  type QueueJobStatus,
  type QueueName,
} from "./queues.js";

type Client = Parameters<typeof listQueues>[0];

interface Config {
  counts?: Partial<Record<QueueName, Partial<Record<QueueJobStatus, number>>>>;
  oldest?: Partial<Record<QueueName, { created_at: string } | null>>;
  deadLetters?: Partial<Record<QueueName, Array<Record<string, unknown>>>>;
  countError?: unknown;
  oldestError?: unknown;
  deadLetterError?: unknown;
}

/**
 * One chainable builder serving all three query shapes this module issues. The
 * shape is inferred from the chain: a select with an options object is a head
 * count, an order on created_at is the oldest-pending lookup, anything else
 * awaited is the dead-letter list.
 */
function makeClient(config: Config = {}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];

  const from = vi.fn((table: QueueName) => {
    let mode: "count" | "dead" = "dead";
    let countedStatus: QueueJobStatus = "pending";

    const builder: Record<string, unknown> = {};
    const chain = (method: string) => (...args: unknown[]) => {
      calls.push({ table, method, args });
      return builder;
    };

    builder.select = (columns: unknown, options?: unknown) => {
      calls.push({ table, method: "select", args: [columns, options] });
      if (options !== undefined) {
        mode = "count";
      }
      return builder;
    };
    builder.eq = (...args: unknown[]) => {
      calls.push({ table, method: "eq", args });
      if (mode === "count") {
        countedStatus = args[1] as QueueJobStatus;
      }
      return builder;
    };
    builder.order = chain("order");
    builder.limit = chain("limit");
    builder.maybeSingle = async () => ({ data: config.oldest?.[table] ?? null, error: config.oldestError ?? null });
    builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
      const result =
        mode === "count"
          ? { data: null, error: config.countError ?? null, count: config.counts?.[table]?.[countedStatus] ?? 0 }
          : { data: config.deadLetters?.[table] ?? [], error: config.deadLetterError ?? null };
      return Promise.resolve(result).then(onFulfilled, onRejected);
    };

    return builder;
  });

  return { client: { from } as unknown as Client, calls };
}

describe("isQueueName", () => {
  it("accepts exactly the three lease queues", () => {
    for (const name of QUEUE_NAMES) {
      expect(isQueueName(name)).toBe(true);
    }
  });

  it("rejects anything else, including near-misses", () => {
    for (const value of ["ingestion", "INGESTION_JOBS", "application_attempts", "", null, undefined, 7, {}]) {
      expect(isQueueName(value)).toBe(false);
    }
  });
});

describe("getQueueSummary", () => {
  it("reports every status count, the oldest pending row and the dead letters", async () => {
    const { client, calls } = makeClient({
      counts: { ingestion_jobs: { pending: 3, leased: 1, done: 42, failed: 2 } },
      oldest: { ingestion_jobs: { created_at: "2026-09-20T10:00:00.000Z" } },
      deadLetters: {
        ingestion_jobs: [
          {
            id: "job-1",
            source_code: "jooble",
            vacancy_source_id: "vs-1",
            attempts: 5,
            max_attempts: 5,
            last_error: "Jooble returned transient HTTP 429",
            updated_at: "2026-09-25T09:00:00.000Z",
          },
        ],
      },
    });

    const summary = await getQueueSummary(client, "ingestion_jobs");

    expect(summary.queue).toBe("ingestion_jobs");
    expect(summary.counts).toEqual({ pending: 3, leased: 1, done: 42, failed: 2 });
    expect(summary.oldestPendingAt).toBe("2026-09-20T10:00:00.000Z");
    expect(summary.deadLetters).toEqual([
      {
        id: "job-1",
        label: "jooble",
        attempts: 5,
        maxAttempts: 5,
        lastError: "Jooble returned transient HTTP 429",
        updatedAt: "2026-09-25T09:00:00.000Z",
      },
    ]);

    // The dead-letter read is bounded, and the bound is the shared constant.
    expect(calls).toContainEqual({ table: "ingestion_jobs", method: "limit", args: [DEAD_LETTER_LIMIT] });
  });

  it("labels a fit-analysis job by the candidate and vacancy, not by a uuid", async () => {
    const { client } = makeClient({
      deadLetters: {
        fit_analysis_jobs: [
          {
            id: "job-2",
            candidate_id: "11111111-1111-1111-1111-111111111111",
            vacancy_id: "22222222-2222-2222-2222-222222222222",
            attempts: 5,
            max_attempts: 5,
            last_error: "AI malformed",
            updated_at: "2026-09-25T09:00:00.000Z",
          },
        ],
      },
    });

    const summary = await getQueueSummary(client, "fit_analysis_jobs");

    expect(summary.deadLetters[0].label).toBe("candidate 11111111 to vacancy 22222222");
  });

  it("labels a registry lookup by its CIN", async () => {
    const { client } = makeClient({
      deadLetters: {
        company_registry_lookup_jobs: [
          {
            id: "job-3",
            company_id: "33333333-3333-3333-3333-333333333333",
            cin: "U72900MH2015PTC123456",
            attempts: 1,
            max_attempts: 5,
            last_error: "No MCA company record found",
            updated_at: null,
          },
        ],
      },
    });

    const summary = await getQueueSummary(client, "company_registry_lookup_jobs");

    expect(summary.deadLetters[0].label).toBe("CIN U72900MH2015PTC123456");
    expect(summary.deadLetters[0].updatedAt).toBeNull();
  });

  it("reports a null oldest pending row when nothing is queued", async () => {
    const { client } = makeClient({ counts: { fit_analysis_jobs: { pending: 0 } }, deadLetters: {} });

    const summary = await getQueueSummary(client, "fit_analysis_jobs");

    expect(summary.counts.pending).toBe(0);
    expect(summary.oldestPendingAt).toBeNull();
    expect(summary.deadLetters).toEqual([]);
  });

  it("treats a missing count as zero rather than NaN", async () => {
    const { client } = makeClient();

    const summary = await getQueueSummary(client, "ingestion_jobs");

    expect(summary.counts).toEqual({ pending: 0, leased: 0, done: 0, failed: 0 });
  });

  it("throws when a count errors", async () => {
    const { client } = makeClient({ countError: { message: "db error" } });

    await expect(getQueueSummary(client, "ingestion_jobs")).rejects.toBeTruthy();
  });

  it("throws when the oldest-pending lookup errors", async () => {
    const { client } = makeClient({ oldestError: { message: "db error" } });

    await expect(getQueueSummary(client, "ingestion_jobs")).rejects.toBeTruthy();
  });

  it("throws when the dead-letter read errors", async () => {
    const { client } = makeClient({ deadLetterError: { message: "db error" } });

    await expect(getQueueSummary(client, "ingestion_jobs")).rejects.toBeTruthy();
  });
});

describe("listQueues", () => {
  it("returns every queue in registry order with the shared dead-letter bound", async () => {
    const { client } = makeClient();

    const overview = await listQueues(client);

    expect(overview.queues.map((entry) => entry.queue)).toEqual([...QUEUE_NAMES]);
    expect(overview.deadLetterLimit).toBe(DEAD_LETTER_LIMIT);
  });
});

describe("rearmFailedJob", () => {
  function makeRearmClient(result: { data: unknown; error: unknown }) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const builder: Record<string, unknown> = {};
    const chain = (method: string) => (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };

    builder.update = chain("update");
    builder.eq = chain("eq");
    builder.select = chain("select");
    builder.maybeSingle = async () => result;

    return { client: { from: vi.fn(() => builder) } as unknown as Client, calls };
  }

  it("re-arms the row in place: pending, attempts reset, lease and error cleared", async () => {
    const { client, calls } = makeRearmClient({ data: { id: "job-1" }, error: null });

    await expect(rearmFailedJob(client, "ingestion_jobs", "job-1")).resolves.toBe(true);

    const update = calls.find((call) => call.method === "update");
    expect(update?.args[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      leased_until: null,
      last_error: null,
    });
    expect((update?.args[0] as { updated_at: string }).updated_at).toBeTruthy();
  });

  it("only ever touches a row that is still failed", async () => {
    const { client, calls } = makeRearmClient({ data: { id: "job-1" }, error: null });

    await rearmFailedJob(client, "fit_analysis_jobs", "job-1");

    expect(calls.filter((call) => call.method === "eq").map((call) => call.args)).toEqual([
      ["id", "job-1"],
      ["status", "failed"],
    ]);
  });

  it("returns false when no failed row matched", async () => {
    const { client } = makeRearmClient({ data: null, error: null });

    await expect(rearmFailedJob(client, "ingestion_jobs", "job-1")).resolves.toBe(false);
  });

  it("throws when the update errors", async () => {
    const { client } = makeRearmClient({ data: null, error: { message: "db error" } });

    await expect(rearmFailedJob(client, "ingestion_jobs", "job-1")).rejects.toBeTruthy();
  });
});
