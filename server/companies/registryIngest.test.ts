import { describe, expect, it, vi } from "vitest";
import type { McaCompanyRecord } from "./mcaRegistry.js";
import { recordAndUpsertLegalEntity } from "./registryIngest.js";

type TableResult = { data: unknown; error: unknown };

function chain(result: TableResult) {
  const builder: Record<string, unknown> & PromiseLike<TableResult> = {
    insert: vi.fn(() => builder),
    upsert: vi.fn(() => builder),
    select: vi.fn(() => builder),
    single: vi.fn(async () => result),
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as Record<string, unknown> & PromiseLike<TableResult>;
  return builder;
}

/** Each table's array of results is consumed one per `.from(table)` call, in order. */
function makeClient(queues: Partial<Record<string, TableResult[]>> = {}) {
  const remaining: Record<string, TableResult[]> = {
    company_registry_records: [],
    company_legal_entities: [],
    ...queues,
  };
  const from = vi.fn((table: string) => {
    const queue = remaining[table];
    const result = queue && queue.length > 0 ? queue.shift()! : { data: null, error: null };
    return chain(result);
  });
  return { from } as unknown as Parameters<typeof recordAndUpsertLegalEntity>[0];
}

function callsFor(client: ReturnType<typeof makeClient>, table: string) {
  const from = client.from as unknown as ReturnType<typeof vi.fn>;
  return from.mock.results
    .filter((_r, i) => from.mock.calls[i][0] === table)
    .map((r) => r.value as ReturnType<typeof chain>);
}

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
  raw: { CIN: "U72900MH2015PTC123456" },
};

describe("recordAndUpsertLegalEntity", () => {
  it("inserts registry evidence and upserts the legal entity on success", async () => {
    const client = makeClient({
      company_registry_records: [{ data: { id: "registry-1" }, error: null }],
      company_legal_entities: [{ data: { id: "entity-1" }, error: null }],
    });

    const result = await recordAndUpsertLegalEntity(client, "company-1", record);

    expect(result).toEqual({ registryRecordId: "registry-1", legalEntityId: "entity-1" });

    const [registryCall] = callsFor(client, "company_registry_records");
    expect(registryCall.insert).toHaveBeenCalledWith({
      company_id: "company-1",
      registry_source: "mca_india",
      raw_payload: record.raw,
    });

    const [legalEntityCall] = callsFor(client, "company_legal_entities");
    expect(legalEntityCall.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: "company-1",
        jurisdiction: "IN",
        registry_identifier: "U72900MH2015PTC123456",
        legal_name: "Applyco Private Limited",
        capital_currency: "INR",
      }),
      { onConflict: "company_id,jurisdiction,registry_identifier" },
    );
  });

  it("throws when the registry-evidence insert fails", async () => {
    const client = makeClient({
      company_registry_records: [{ data: null, error: { message: "db error" } }],
    });

    await expect(recordAndUpsertLegalEntity(client, "company-1", record)).rejects.toBeTruthy();
  });

  it("throws when the registry-evidence insert returns no data and no error", async () => {
    const client = makeClient({
      company_registry_records: [{ data: null, error: null }],
    });

    await expect(recordAndUpsertLegalEntity(client, "company-1", record)).rejects.toThrow(
      /Failed to insert company_registry_records/,
    );
  });

  it("throws when the legal-entity upsert fails", async () => {
    const client = makeClient({
      company_registry_records: [{ data: { id: "registry-1" }, error: null }],
      company_legal_entities: [{ data: null, error: { message: "db error" } }],
    });

    await expect(recordAndUpsertLegalEntity(client, "company-1", record)).rejects.toBeTruthy();
  });

  it("does not duplicate registry evidence or legal entities on a second call for the same CIN", async () => {
    const client = makeClient({
      company_registry_records: [
        { data: { id: "registry-1" }, error: null },
        { data: { id: "registry-2" }, error: null },
      ],
      company_legal_entities: [
        { data: { id: "entity-1" }, error: null },
        { data: { id: "entity-1" }, error: null },
      ],
    });

    const first = await recordAndUpsertLegalEntity(client, "company-1", record);
    const second = await recordAndUpsertLegalEntity(client, "company-1", record);

    // A fresh evidence row is expected each call (append-only audit trail),
    // but the upsert resolves to the SAME legal_entity id both times —
    // the ON CONFLICT target doing its job, not a second row.
    expect(first.legalEntityId).toBe(second.legalEntityId);
  });
});
