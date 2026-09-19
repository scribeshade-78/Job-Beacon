import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ingestDiscoveredVacancy and scoreVacancy are mocked because they are not what
 * this file is about: the write path has its own suite (ingestion/ingest.test.ts)
 * and the trust rule has its own (trust/scoreVacancy.test.ts). What is under
 * test here is intake's own decisions — the policy gate, the order of scoring
 * and status application, and what it reports.
 */
vi.mock("../ingestion/ingest.js", () => ({
  ingestDiscoveredVacancy: vi.fn(),
}));

vi.mock("../trust/scoreVacancy.js", () => ({
  scoreVacancy: vi.fn(),
}));

vi.mock("./adapters/registry.js", () => ({
  getIntakeAdapter: vi.fn(),
  listIntakeAdapters: vi.fn(),
  intakeAdapterRegistry: new Map(),
}));

import { ingestDiscoveredVacancy } from "../ingestion/ingest.js";
import { scoreVacancy } from "../trust/scoreVacancy.js";
import { getIntakeAdapter } from "./adapters/registry.js";
import { IntakePolicyError, runIntake } from "./intake.js";

type TableResult = { data: unknown; error: unknown };

function makeQueryBuilder(result: TableResult) {
  const builder: PromiseLike<TableResult> & Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => result,
    single: async () => result,
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as PromiseLike<TableResult> & Record<string, unknown>;
  return builder;
}

interface MakeClientOptions {
  policy?: TableResult;
  vacancySource?: TableResult;
}

function makeClient(options: MakeClientOptions = {}) {
  const results: Record<string, TableResult> = {
    source_policies:
      options.policy ?? { data: { discovery_allowed: true, kill_switch: false }, error: null },
    vacancy_sources: options.vacancySource ?? { data: { id: "vs-1" }, error: null },
    vacancies: { data: null, error: null },
    source_health_events: { data: null, error: null },
  };

  const statusUpdates: Array<{ id: string; trust_status: string }> = [];
  const healthEvents: Array<Record<string, unknown>> = [];

  const from = vi.fn((table: string) => {
    const result = results[table];
    if (!result) throw new Error(`Unexpected table: ${table}`);
    const builder = makeQueryBuilder(result);

    builder.update = (payload: unknown) => {
      const chain: Record<string, unknown> = {
        eq: async (_column: string, value: string) => {
          if (table === "vacancies") {
            statusUpdates.push({ id: value, trust_status: (payload as { trust_status: string }).trust_status });
          }
          return { data: null, error: null };
        },
      };
      return chain;
    };

    if (table === "source_health_events") {
      builder.insert = (payload: unknown) => {
        healthEvents.push(payload as Record<string, unknown>);
        return Promise.resolve({ data: null, error: null });
      };
    }

    return builder;
  });

  return { client: { from } as never, statusUpdates, healthEvents };
}

const discovered = {
  sourceVacancyId: "1",
  authoritativeUrl: "https://remotive.com/remote-jobs/x-1",
  rawTitle: "Senior Data Engineer",
  companyName: "Acme",
  companyDomain: null,
  country: null,
  region: "Worldwide",
  city: null,
  remoteType: "remote" as const,
  currency: null,
  salaryMin: null,
  salaryMax: null,
  salaryInterval: null,
  salarySource: null,
  publishedAt: "2026-09-16T12:35:28",
  raw: { id: 1 },
};

function adapterReturning(vacancies: unknown[], received = vacancies.length, skipped = 0) {
  return {
    sourceCode: "remotive",
    displayName: "Remotive (public remote-job API)",
    attribution: "Job data from Remotive (https://remotive.com), delayed by 24 hours.",
    fetchLiveJobs: vi.fn(async () => ({ vacancies, received, skipped })),
  };
}

beforeEach(() => {
  vi.mocked(ingestDiscoveredVacancy).mockReset();
  vi.mocked(scoreVacancy).mockReset();
  vi.mocked(getIntakeAdapter).mockReset();
  vi.mocked(ingestDiscoveredVacancy).mockResolvedValue({ vacancyId: "vac-1", outcome: "created" });
});

describe("runIntake — source policy", () => {
  it("refuses a source whose kill switch is on", async () => {
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning([]) as never);
    const { client } = makeClient({
      policy: { data: { discovery_allowed: true, kill_switch: true }, error: null },
    });

    await expect(runIntake(client, { sourceCode: "remotive" })).rejects.toBeInstanceOf(IntakePolicyError);
    // Refused before any network call: a switched-off source is off for agents
    // too, not just for the scheduler.
    expect(vi.mocked(ingestDiscoveredVacancy)).not.toHaveBeenCalled();
  });

  it("refuses a source whose discovery_allowed is false", async () => {
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning([]) as never);
    const { client } = makeClient({
      policy: { data: { discovery_allowed: false, kill_switch: false }, error: null },
    });

    await expect(runIntake(client, { sourceCode: "remotive" })).rejects.toBeInstanceOf(IntakePolicyError);
  });

  it("refuses a source with no policy row at all, rather than assuming permission", async () => {
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning([]) as never);
    const { client } = makeClient({ policy: { data: null, error: null } });

    await expect(runIntake(client, { sourceCode: "remotive" })).rejects.toThrow(/no source_policies row/);
  });

  it("refuses when the source has no vacancy_sources row, since the FK requires one", async () => {
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning([]) as never);
    const { client } = makeClient({ vacancySource: { data: null, error: null } });

    await expect(runIntake(client, { sourceCode: "remotive" })).rejects.toThrow(/vacancy_sources row/);
  });
});

describe("runIntake — ingestion and status", () => {
  it("writes through the shared ingestion path, not a second insert of its own", async () => {
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning([discovered]) as never);
    vi.mocked(scoreVacancy).mockResolvedValue({ status: "UNDER_REVIEW", score: 60, reasonCodes: [] } as never);
    const { client } = makeClient();

    await runIntake(client, { sourceCode: "remotive" });

    expect(ingestDiscoveredVacancy).toHaveBeenCalledWith(
      expect.anything(),
      "remotive",
      "vs-1",
      discovered,
    );
  });

  it("does not write a trust status of its own", async () => {
    // The scorer is the only writer. Intake overwriting vacancies.trust_status
    // afterwards is exactly what left it disagreeing with
    // vacancy_trust_scores.status before Task Y.
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning([discovered]) as never);
    vi.mocked(scoreVacancy).mockResolvedValue({ status: "VERIFIED_INCOMPLETE", score: 60, reasonCodes: [] } as never);
    const { client, statusUpdates } = makeClient();

    await runIntake(client, { sourceCode: "remotive" });

    expect(statusUpdates).toEqual([]);
  });

  it("reports the distribution of statuses the scorer actually produced", async () => {
    const three = [discovered, { ...discovered, sourceVacancyId: "2" }, { ...discovered, sourceVacancyId: "3" }];
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning(three) as never);
    vi.mocked(scoreVacancy)
      .mockResolvedValueOnce({ status: "VERIFIED_INCOMPLETE", score: 60, reasonCodes: [] } as never)
      .mockResolvedValueOnce({ status: "VERIFIED_INCOMPLETE", score: 62, reasonCodes: [] } as never)
      .mockResolvedValueOnce({ status: "FLAGGED", score: 20, reasonCodes: [] } as never);
    vi.mocked(ingestDiscoveredVacancy)
      .mockResolvedValueOnce({ vacancyId: "vac-1", outcome: "created" })
      .mockResolvedValueOnce({ vacancyId: "vac-2", outcome: "created" })
      .mockResolvedValueOnce({ vacancyId: "vac-3", outcome: "created" });
    const { client } = makeClient();

    const result = await runIntake(client, { sourceCode: "remotive", limit: 3 });

    expect(result.trustStatusCounts).toEqual({ VERIFIED_INCOMPLETE: 2, FLAGGED: 1 });
  });

  it("still runs the scorer, so the score row and fit enqueue exist", async () => {
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning([discovered]) as never);
    vi.mocked(scoreVacancy).mockResolvedValue({ status: "VERIFIED", score: 88, reasonCodes: [] } as never);
    const { client } = makeClient();

    await runIntake(client, { sourceCode: "remotive" });

    expect(scoreVacancy).toHaveBeenCalledWith(expect.anything(), "vac-1");
  });

  it("reports the scorer's status per vacancy, so a FLAGGED listing is visible in the result", async () => {
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning([discovered]) as never);
    vi.mocked(scoreVacancy).mockResolvedValue({ status: "FLAGGED", score: 20, reasonCodes: [] } as never);
    const { client } = makeClient();

    const result = await runIntake(client, { sourceCode: "remotive" });

    expect(result.outcomes[0].trustStatus).toBe("FLAGGED");
  });

  it("leaves an unscored vacancy alone rather than inventing a status for it", async () => {
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning([discovered]) as never);
    vi.mocked(scoreVacancy).mockRejectedValue(new Error("company lookup down"));
    const { client, statusUpdates } = makeClient();

    const result = await runIntake(client, { sourceCode: "remotive" });

    // trust_status stays NULL: neither eligible nor visible, and the next
    // scoring pass picks it up. Writing a status the scorer never concluded
    // would be the same dishonesty in a different place.
    expect(statusUpdates).toEqual([]);
    expect(result.outcomes[0].scoreError).toBe("company lookup down");
    expect(result.trustStatusCounts).toEqual({ unscored: 1 });
    // The vacancy is still ingested — a scoring failure is not an ingestion failure.
    expect(result.ingested).toBe(1);
  });

  it("reports what the source returned versus what it could use", async () => {
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning([discovered], 9, 8) as never);
    vi.mocked(scoreVacancy).mockResolvedValue({ status: "VERIFIED", score: 90, reasonCodes: [] } as never);
    const { client } = makeClient();

    const result = await runIntake(client, { sourceCode: "remotive" });

    expect(result.received).toBe(9);
    expect(result.skippedByAdapter).toBe(8);
    expect(result.ingested).toBe(1);
  });

  it("passes the trimmed search through and reports null when there was none", async () => {
    const adapter = adapterReturning([]);
    vi.mocked(getIntakeAdapter).mockReturnValue(adapter as never);
    const { client } = makeClient();

    const withSearch = await runIntake(client, { sourceCode: "remotive", search: "  data engineer  " });
    const withoutSearch = await runIntake(client, { sourceCode: "remotive", search: "   " });

    expect(adapter.fetchLiveJobs).toHaveBeenCalledWith({ search: "data engineer", limit: 20 }, undefined);
    expect(withSearch.search).toBe("data engineer");
    expect(withoutSearch.search).toBeNull();
  });

  it("clamps the limit instead of letting an agent ask for a thousand", async () => {
    const adapter = adapterReturning([]);
    vi.mocked(getIntakeAdapter).mockReturnValue(adapter as never);
    const { client } = makeClient();

    await runIntake(client, { sourceCode: "remotive", limit: 5000 });

    expect(adapter.fetchLiveJobs).toHaveBeenCalledWith({ search: undefined, limit: 100 }, undefined);
  });

  it("records a success health event with the fetched count", async () => {
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning([discovered]) as never);
    vi.mocked(scoreVacancy).mockResolvedValue({ status: "VERIFIED", score: 90, reasonCodes: [] } as never);
    const { client, healthEvents } = makeClient();

    await runIntake(client, { sourceCode: "remotive" });

    expect(healthEvents.at(-1)).toMatchObject({ source_code: "remotive", status: "success", vacancies_fetched: 1 });
  });

  it("records an error health event and rethrows when the source fails", async () => {
    const failing = adapterReturning([]);
    failing.fetchLiveJobs = vi.fn(async () => {
      throw new Error("HTTP 503");
    }) as never;
    vi.mocked(getIntakeAdapter).mockReturnValue(failing as never);
    const { client, healthEvents } = makeClient();

    await expect(runIntake(client, { sourceCode: "remotive" })).rejects.toThrow(/503/);

    expect(healthEvents.at(-1)).toMatchObject({ status: "error", error_message: "HTTP 503" });
    expect(vi.mocked(ingestDiscoveredVacancy)).not.toHaveBeenCalled();
  });

  it("does not expire anything, because a targeted search is not a full sweep", async () => {
    // markUnseenVacanciesExpired is deliberately absent from intake: running it
    // after a search for "data engineer" would expire every other posting.
    vi.mocked(getIntakeAdapter).mockReturnValue(adapterReturning([discovered]) as never);
    vi.mocked(scoreVacancy).mockResolvedValue({ status: "VERIFIED", score: 90, reasonCodes: [] } as never);
    const { client } = makeClient();

    await runIntake(client, { sourceCode: "remotive" });

    const tablesTouched = (client as unknown as { from: { mock: { calls: unknown[][] } } }).from.mock.calls.map(
      (call) => call[0],
    );
    expect(tablesTouched).not.toContain("ingestion_jobs");
  });
});
