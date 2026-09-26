import { describe, expect, it, vi } from "vitest";
import {
  clampSourceHealthLimit,
  DEFAULT_SOURCE_HEALTH_LIMIT,
  isSourceHealthStatus,
  listSourceHealthEvents,
  MAX_SOURCE_HEALTH_LIMIT,
  summarizeBySource,
  type SourceHealthEvent,
} from "./sourceHealth.js";

type Client = Parameters<typeof listSourceHealthEvents>[0];

/**
 * A chainable, thenable builder: every query method returns the builder and
 * awaiting it yields the configured result. That is what lets one mock serve
 * the no-filter, one-filter and two-filter call shapes without each test
 * hand-building its own chain.
 */
function makeClient(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};
  const chain = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return builder;
  };

  builder.select = chain("select");
  builder.eq = chain("eq");
  builder.order = chain("order");
  builder.limit = chain("limit");
  builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);

  const from = vi.fn((table: string) => {
    if (table !== "source_health_events") {
      throw new Error("Unexpected table: " + table);
    }
    return builder;
  });

  return { client: { from } as unknown as Client, calls, from };
}

const sampleRow = {
  id: "e1",
  source_code: "remotive",
  vacancy_source_id: "vs-1",
  status: "success",
  vacancies_fetched: 12,
  error_message: null,
  duration_ms: 340,
  run_at: "2026-09-26T10:00:00.000Z",
};

function makeEvent(overrides: Partial<SourceHealthEvent>): SourceHealthEvent {
  return {
    id: "e",
    sourceCode: "remotive",
    vacancySourceId: null,
    status: "success",
    vacanciesFetched: 0,
    errorMessage: null,
    durationMs: null,
    runAt: "2026-09-26T10:00:00.000Z",
    ...overrides,
  };
}

describe("isSourceHealthStatus", () => {
  it("accepts exactly the two statuses the table CHECK allows", () => {
    expect(isSourceHealthStatus("success")).toBe(true);
    expect(isSourceHealthStatus("error")).toBe(true);
  });

  it("rejects everything else, including statuses this table does not have", () => {
    for (const value of ["skipped", "rate_limited", "Success", "", null, undefined, 3, {}]) {
      expect(isSourceHealthStatus(value)).toBe(false);
    }
  });
});

describe("clampSourceHealthLimit", () => {
  it("defaults when no limit is given, or when it is not a finite number", () => {
    expect(clampSourceHealthLimit(undefined)).toBe(DEFAULT_SOURCE_HEALTH_LIMIT);
    expect(clampSourceHealthLimit(Number.NaN)).toBe(DEFAULT_SOURCE_HEALTH_LIMIT);
    expect(clampSourceHealthLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SOURCE_HEALTH_LIMIT);
  });

  it("clamps into range and truncates a fraction rather than passing it through", () => {
    expect(clampSourceHealthLimit(0)).toBe(1);
    expect(clampSourceHealthLimit(-5)).toBe(1);
    expect(clampSourceHealthLimit(12.9)).toBe(12);
    expect(clampSourceHealthLimit(9999)).toBe(MAX_SOURCE_HEALTH_LIMIT);
    expect(clampSourceHealthLimit(250)).toBe(250);
  });
});

describe("listSourceHealthEvents", () => {
  it("maps rows to camelCase and derives the per-source summary", async () => {
    const { client } = makeClient({ data: [sampleRow], error: null });

    const result = await listSourceHealthEvents(client);

    expect(result.events).toEqual([
      {
        id: "e1",
        sourceCode: "remotive",
        vacancySourceId: "vs-1",
        status: "success",
        vacanciesFetched: 12,
        errorMessage: null,
        durationMs: 340,
        runAt: "2026-09-26T10:00:00.000Z",
      },
    ]);
    expect(result.sources).toEqual([
      {
        sourceCode: "remotive",
        latestRunAt: "2026-09-26T10:00:00.000Z",
        latestStatus: "success",
        latestErrorMessage: null,
        latestVacanciesFetched: 12,
        latestDurationMs: 340,
        eventsInWindow: 1,
        errorsInWindow: 0,
      },
    ]);
    expect(result.limit).toBe(DEFAULT_SOURCE_HEALTH_LIMIT);
    expect(result.truncated).toBe(false);
  });

  it("orders newest first and asks for one row beyond the limit", async () => {
    const { client, calls } = makeClient({ data: [], error: null });

    await listSourceHealthEvents(client, { limit: 50 });

    expect(calls).toContainEqual({ method: "order", args: ["run_at", { ascending: false }] });
    expect(calls).toContainEqual({ method: "limit", args: [51] });
  });

  it("applies no equality filter when neither filter is given", async () => {
    const { client, calls } = makeClient({ data: [], error: null });

    await listSourceHealthEvents(client, { sourceCode: null, status: null });

    expect(calls.some((call) => call.method === "eq")).toBe(false);
  });

  it("applies the sourceCode and status filters it was given", async () => {
    const { client, calls } = makeClient({ data: [], error: null });

    await listSourceHealthEvents(client, { sourceCode: "jooble", status: "error" });

    expect(calls).toContainEqual({ method: "eq", args: ["source_code", "jooble"] });
    expect(calls).toContainEqual({ method: "eq", args: ["status", "error"] });
  });

  it("reports truncation and drops the extra row when older rows exist", async () => {
    const rows = [sampleRow, { ...sampleRow, id: "e2" }, { ...sampleRow, id: "e3" }];
    const { client } = makeClient({ data: rows, error: null });

    const result = await listSourceHealthEvents(client, { limit: 2 });

    expect(result.truncated).toBe(true);
    expect(result.events.map((event) => event.id)).toEqual(["e1", "e2"]);
  });

  it("does not claim truncation when the table simply ended at the page size", async () => {
    const { client } = makeClient({ data: [sampleRow, { ...sampleRow, id: "e2" }], error: null });

    const result = await listSourceHealthEvents(client, { limit: 2 });

    expect(result.truncated).toBe(false);
    expect(result.events).toHaveLength(2);
  });

  it("throws when the query errors", async () => {
    const { client } = makeClient({ data: null, error: { message: "db error" } });

    await expect(listSourceHealthEvents(client)).rejects.toBeTruthy();
  });

  it("returns an empty window rather than nulls when there are no rows", async () => {
    const { client } = makeClient({ data: null, error: null });

    await expect(listSourceHealthEvents(client)).resolves.toEqual({
      events: [],
      sources: [],
      limit: DEFAULT_SOURCE_HEALTH_LIMIT,
      truncated: false,
    });
  });
});

describe("summarizeBySource", () => {
  it("picks the latest run per source regardless of input order, and counts errors", () => {
    const events = [
      makeEvent({ id: "a", sourceCode: "remotive", status: "success", runAt: "2026-09-26T10:00:00.000Z" }),
      makeEvent({
        id: "b",
        sourceCode: "remotive",
        status: "error",
        errorMessage: "HTTP 429 from the Remotive job board API",
        runAt: "2026-09-26T12:00:00.000Z",
      }),
      makeEvent({ id: "c", sourceCode: "adzuna", status: "error", errorMessage: "HTTP 500", runAt: "2026-09-26T11:00:00.000Z" }),
    ];

    const summary = summarizeBySource(events);

    expect(summary.map((entry) => entry.sourceCode)).toEqual(["adzuna", "remotive"]);
    expect(summary[1]).toEqual({
      sourceCode: "remotive",
      latestRunAt: "2026-09-26T12:00:00.000Z",
      latestStatus: "error",
      latestErrorMessage: "HTTP 429 from the Remotive job board API",
      latestVacanciesFetched: 0,
      latestDurationMs: null,
      eventsInWindow: 2,
      errorsInWindow: 1,
    });
    expect(summary[0].eventsInWindow).toBe(1);
    expect(summary[0].errorsInWindow).toBe(1);
  });

  it("returns an empty list for an empty window", () => {
    expect(summarizeBySource([])).toEqual([]);
  });

  it("keeps the newest row even when the input is newest-first rather than shuffled", () => {
    const events = [
      makeEvent({ sourceCode: "jooble", status: "error", runAt: "2026-09-26T12:00:00.000Z" }),
      makeEvent({ sourceCode: "jooble", status: "success", runAt: "2026-09-26T09:00:00.000Z" }),
    ];

    expect(summarizeBySource(events)[0].latestStatus).toBe("error");
  });
});
