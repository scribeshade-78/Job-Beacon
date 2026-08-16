import { describe, expect, it, vi } from "vitest";

vi.mock("./adapters/greenhouse.js", () => ({ discoverGreenhouse: vi.fn() }));
vi.mock("./adapters/lever.js", () => ({ discoverLever: vi.fn() }));
vi.mock("./adapters/usajobs.js", () => ({ discoverUsajobs: vi.fn() }));
vi.mock("./adapters/adzuna.js", () => ({ discoverAdzuna: vi.fn() }));
vi.mock("./ingest.js", () => ({
  ingestDiscoveredVacancy: vi.fn(),
  markUnseenVacanciesExpired: vi.fn(),
}));

import { discoverGreenhouse } from "./adapters/greenhouse.js";
import { ingestDiscoveredVacancy, markUnseenVacanciesExpired } from "./ingest.js";
import { runOneIngestionJob } from "./worker.js";

const job = {
  id: "job-1",
  source_code: "greenhouse",
  vacancy_source_id: "target-1",
  attempts: 1,
  max_attempts: 5,
};

const vacancySource = {
  id: "target-1",
  source_code: "greenhouse",
  target_key: "acme",
  config: { companyName: "Acme Corp" },
};

const enabledPolicy = { discovery_allowed: true, kill_switch: false };

function chain(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    update: vi.fn(() => builder),
    single: vi.fn(async () => result),
    insert: vi.fn(async () => result),
  };
  return builder;
}

function makeClient(overrides: {
  rpcResult?: { data: unknown; error: unknown };
  vacancySourceResult?: { data: unknown; error: unknown };
  policyResult?: { data: unknown; error: unknown };
  healthInsertResult?: { data: unknown; error: unknown };
  jobUpdateResult?: { data: unknown; error: unknown };
} = {}) {
  const rpc = vi.fn(async () => overrides.rpcResult ?? { data: [job], error: null });
  const from = vi.fn((table: string) => {
    if (table === "vacancy_sources") return chain(overrides.vacancySourceResult ?? { data: vacancySource, error: null });
    if (table === "source_policies") return chain(overrides.policyResult ?? { data: enabledPolicy, error: null });
    if (table === "source_health_events") return chain(overrides.healthInsertResult ?? { data: null, error: null });
    if (table === "ingestion_jobs") return chain(overrides.jobUpdateResult ?? { data: null, error: null });
    return chain({ data: null, error: null });
  });

  return { rpc, from } as unknown as Parameters<typeof runOneIngestionJob>[0];
}

describe("runOneIngestionJob", () => {
  it("returns processed:false when the queue is empty", async () => {
    const client = makeClient({ rpcResult: { data: [], error: null } });

    const result = await runOneIngestionJob(client);

    expect(result).toEqual({ processed: false });
  });

  it("throws when the claim RPC itself errors", async () => {
    const client = makeClient({ rpcResult: { data: null, error: { message: "rpc failed" } } });

    await expect(runOneIngestionJob(client)).rejects.toBeTruthy();
  });

  it("discovers, ingests each result, marks freshness, and completes the job on success", async () => {
    const discovered = [{ sourceVacancyId: "1" }, { sourceVacancyId: "2" }];
    vi.mocked(discoverGreenhouse).mockResolvedValue(discovered as never);
    vi.mocked(ingestDiscoveredVacancy)
      .mockResolvedValueOnce({ vacancyId: "v1", outcome: "created" })
      .mockResolvedValueOnce({ vacancyId: "v2", outcome: "created" });

    const client = makeClient();
    const result = await runOneIngestionJob(client);

    expect(result).toEqual({ processed: true, vacanciesFetched: 2 });
    expect(discoverGreenhouse).toHaveBeenCalledWith("acme", vacancySource.config);
    expect(ingestDiscoveredVacancy).toHaveBeenCalledTimes(2);
    expect(markUnseenVacanciesExpired).toHaveBeenCalledWith(client, "target-1", ["v1", "v2"]);
  });

  it("does not call the adapter and fails the job when discovery_allowed is false", async () => {
    vi.mocked(discoverGreenhouse).mockClear();
    const client = makeClient({ policyResult: { data: { discovery_allowed: false, kill_switch: false }, error: null } });

    const result = await runOneIngestionJob(client);

    expect(result.processed).toBe(true);
    expect(result.error).toMatch(/not permitted/);
    expect(discoverGreenhouse).not.toHaveBeenCalled();
  });

  it("does not call the adapter and fails the job when kill_switch is engaged", async () => {
    vi.mocked(discoverGreenhouse).mockClear();
    const client = makeClient({ policyResult: { data: { discovery_allowed: true, kill_switch: true }, error: null } });

    const result = await runOneIngestionJob(client);

    expect(result.error).toMatch(/not permitted/);
    expect(discoverGreenhouse).not.toHaveBeenCalled();
  });

  it("rejects a Greenhouse target with no companyName instead of letting a bad insert happen downstream", async () => {
    vi.mocked(discoverGreenhouse).mockClear();
    const client = makeClient({
      vacancySourceResult: { data: { ...vacancySource, config: {} }, error: null },
    });

    const result = await runOneIngestionJob(client);

    expect(result.error).toMatch(/companyName/);
    expect(discoverGreenhouse).not.toHaveBeenCalled();
  });

  it("throws for a source_code with no registered adapter", async () => {
    const client = makeClient({
      vacancySourceResult: { data: { ...vacancySource, source_code: "not-a-real-source" }, error: null },
      policyResult: { data: enabledPolicy, error: null },
    });

    const result = await runOneIngestionJob(client);

    expect(result.error).toMatch(/No discovery adapter registered/);
  });
});
