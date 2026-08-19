import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./mcaRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcaRegistry.js")>();
  return { ...actual, fetchMcaCompanyByCin: vi.fn() };
});
vi.mock("./registryIngest.js", () => ({ recordAndUpsertLegalEntity: vi.fn() }));

import { fetchMcaCompanyByCin, McaRecordNotFoundError, type McaCompanyRecord } from "./mcaRegistry.js";
import { recordAndUpsertLegalEntity } from "./registryIngest.js";
import { runOneRegistryLookupJob } from "./registryWorker.js";

const claimedJob = {
  id: "job-1",
  company_id: "company-1",
  cin: "U72900MH2015PTC123456",
  attempts: 1,
  max_attempts: 5,
};

const credentials = { apiKey: "test-api-key", resourceId: "test-resource-id" };

const record: McaCompanyRecord = {
  cin: "U72900MH2015PTC123456",
  legalName: "Applyco Private Limited",
  registrationStatus: "Active",
  registrationDate: "2015-04-01",
  companyCategory: "Company limited by Shares",
  companyClass: "Private",
  authorizedCapital: 5000000,
  paidUpCapital: 3200000,
  registeredRegion: "Maharashtra",
  registrar: "RoC-Mumbai",
  raw: {},
};

function chain() {
  const builder = {
    update: vi.fn(() => builder),
    eq: vi.fn(async () => ({ data: null, error: null })),
  };
  return builder;
}

function makeClient(rpcResult: { data: unknown; error: unknown } = { data: [claimedJob], error: null }) {
  const rpc = vi.fn(async () => rpcResult);
  const from = vi.fn(() => chain());
  return { rpc, from } as unknown as Parameters<typeof runOneRegistryLookupJob>[0];
}

describe("runOneRegistryLookupJob", () => {
  beforeEach(() => {
    vi.mocked(fetchMcaCompanyByCin).mockClear();
    vi.mocked(recordAndUpsertLegalEntity).mockClear();
  });

  it("returns processed:false when the queue is empty", async () => {
    const client = makeClient({ data: [], error: null });
    const result = await runOneRegistryLookupJob(client, credentials);
    expect(result).toEqual({ processed: false });
  });

  it("throws when the claim RPC itself errors", async () => {
    const client = makeClient({ data: null, error: { message: "rpc failed" } });
    await expect(runOneRegistryLookupJob(client, credentials)).rejects.toBeTruthy();
  });

  it("marks the job done on a successful lookup", async () => {
    vi.mocked(fetchMcaCompanyByCin).mockResolvedValueOnce(record);
    vi.mocked(recordAndUpsertLegalEntity).mockResolvedValueOnce({
      registryRecordId: "registry-1",
      legalEntityId: "entity-1",
    });
    const client = makeClient();

    const result = await runOneRegistryLookupJob(client, credentials);

    expect(result).toEqual({ processed: true, jobId: "job-1", outcome: "done" });
    expect(fetchMcaCompanyByCin).toHaveBeenCalledWith("U72900MH2015PTC123456", credentials);
    expect(recordAndUpsertLegalEntity).toHaveBeenCalledWith(client, "company-1", record);

    const jobsTable = (client.from as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(jobsTable.update).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }));
  });

  it("dead-letters immediately (no retry) when the CIN is not found, even with attempts remaining", async () => {
    vi.mocked(fetchMcaCompanyByCin).mockRejectedValueOnce(new McaRecordNotFoundError("U72900MH2015PTC123456"));
    const client = makeClient();

    const result = await runOneRegistryLookupJob(client, credentials);

    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/No MCA company record found/);

    const jobsTable = (client.from as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(jobsTable.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", last_error: expect.stringMatching(/No MCA company record found/) }),
    );
    expect(recordAndUpsertLegalEntity).not.toHaveBeenCalled();
  });

  it("records an error and reschedules with backoff when the lookup fails transiently and attempts remain", async () => {
    vi.mocked(fetchMcaCompanyByCin).mockRejectedValueOnce(new Error("network error"));
    const client = makeClient();

    const result = await runOneRegistryLookupJob(client, credentials);

    expect(result).toEqual({ processed: true, jobId: "job-1", outcome: "failed", error: "network error" });

    const jobsTable = (client.from as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(jobsTable.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "leased", last_error: "network error" }),
    );
  });

  it("dead-letters (status: failed) once max_attempts is reached instead of rescheduling", async () => {
    vi.mocked(fetchMcaCompanyByCin).mockRejectedValueOnce(new Error("still failing"));
    const client = makeClient({
      data: [{ id: "job-2", company_id: "company-1", cin: "U00000000000000000000", attempts: 5, max_attempts: 5 }],
      error: null,
    });

    const result = await runOneRegistryLookupJob(client, credentials);

    expect(result).toEqual({ processed: true, jobId: "job-2", outcome: "failed", error: "still failing" });

    const jobsTable = (client.from as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(jobsTable.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", last_error: "still failing" }),
    );
  });
});
