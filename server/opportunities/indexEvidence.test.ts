import { describe, expect, it, vi } from "vitest";
import { TOKENIZER_VERSION, evidenceFingerprint } from "../../shared/evidenceTokens.js";
import { indexVacancyEvidence, latestSnapshotByVacancy } from "./indexEvidence.js";

/**
 * MOCKED CLIENT, NOT DATABASE VALIDATION: the emitted upsert payload and the
 * batch accounting are asserted; the array column, the GIN index and RLS are not
 * exercised by anything here.
 */

interface Config {
  vacancies?: Array<{ id: string; raw_title: string | null }>;
  snapshots?: Array<{ id: string; vacancy_id: string; clean_text: string | null; created_at: string }>;
  tokens?: Array<{ vacancy_id: string; tokenizer_version: string; evidence_fingerprint: string }>;
  upsertError?: { message: string } | null;
}

function makeClient(config: Config = {}) {
  const upserts: Array<Array<Record<string, unknown>>> = [];

  const from = vi.fn((table: string) => {
    const builder: any = {
      select: () => builder,
      order: () => builder,
      in: () => builder,
      range: async () => ({ data: config.vacancies ?? [], error: null }),
      upsert: async (rows: Array<Record<string, unknown>>) => {
        upserts.push(rows);
        return { error: config.upsertError ?? null };
      },
      then: (resolve: (value: unknown) => unknown) => {
        const data =
          table === "vacancy_jd_snapshots"
            ? (config.snapshots ?? [])
            : table === "vacancy_evidence_tokens"
              ? (config.tokens ?? [])
              : [];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return builder;
  });

  return { client: { from } as never, upserts };
}

const vacancy = { id: "v1", raw_title: "Data Engineer" };
const snapshot = {
  id: "s1",
  vacancy_id: "v1",
  clean_text: "Azure data platform.",
  created_at: "2026-10-01T00:00:00Z",
};

describe("latestSnapshotByVacancy", () => {
  it("keeps the newest captured description per vacancy", () => {
    const older = { ...snapshot, id: "s0", clean_text: "old", created_at: "2026-09-01T00:00:00Z" };
    const latest = latestSnapshotByVacancy([older, snapshot]);

    expect(latest.get("v1")?.id).toBe("s1");
  });
});

describe("indexVacancyEvidence", () => {
  it("writes tokens with the tokenizer version and the evidence fingerprint", async () => {
    const { client, upserts } = makeClient({ vacancies: [vacancy], snapshots: [snapshot] });

    const result = await indexVacancyEvidence(client);

    expect(result.indexed).toBe(1);
    expect(result.titleOnly).toBe(0);
    expect(upserts[0][0]).toMatchObject({
      vacancy_id: "v1",
      jd_snapshot_id: "s1",
      tokenizer_version: TOKENIZER_VERSION,
      evidence_fingerprint: evidenceFingerprint({ title: "Data Engineer", description: "Azure data platform." }),
    });
    expect(upserts[0][0].tokens).toContain("azure");
  });

  it("indexes from the title alone and reports it when no description was captured", async () => {
    const { client, upserts } = makeClient({ vacancies: [vacancy], snapshots: [] });

    const result = await indexVacancyEvidence(client);

    expect(result.titleOnly).toBe(1);
    expect(upserts[0][0].jd_snapshot_id).toBeNull();
    expect(upserts[0][0].tokens).toEqual(["data", "engineer"]);
  });

  it("skips a row that is already current for the same version and evidence", async () => {
    const { client, upserts } = makeClient({
      vacancies: [vacancy],
      snapshots: [snapshot],
      tokens: [
        {
          vacancy_id: "v1",
          tokenizer_version: TOKENIZER_VERSION,
          evidence_fingerprint: evidenceFingerprint({ title: "Data Engineer", description: "Azure data platform." }),
        },
      ],
    });

    const result = await indexVacancyEvidence(client);

    expect(result.skippedCurrent).toBe(1);
    expect(result.indexed).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it("re-indexes a row whose tokenizer version is stale", async () => {
    const { client, upserts } = makeClient({
      vacancies: [vacancy],
      snapshots: [snapshot],
      tokens: [{ vacancy_id: "v1", tokenizer_version: "evidence-tokens-v0", evidence_fingerprint: "old" }],
    });

    const result = await indexVacancyEvidence(client);

    expect(result.indexed).toBe(1);
    expect(upserts).toHaveLength(1);
  });

  it("writes nothing in dry-run but reports what would change", async () => {
    const { client, upserts } = makeClient({ vacancies: [vacancy], snapshots: [snapshot] });

    const result = await indexVacancyEvidence(client, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.wouldIndex).toBe(1);
    expect(result.indexed).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it("reports a failed batch instead of silently leaving a gap", async () => {
    const { client } = makeClient({
      vacancies: [vacancy],
      snapshots: [snapshot],
      upsertError: { message: "tokens unavailable" },
    });

    const result = await indexVacancyEvidence(client);

    expect(result.indexed).toBe(0);
    expect(result.failures).toEqual([{ vacancyId: "v1", error: "tokens unavailable" }]);
  });

  it("reports the resume offset and completion for a bounded run", async () => {
    const { client } = makeClient({ vacancies: [vacancy], snapshots: [snapshot] });

    const result = await indexVacancyEvidence(client, { batchSize: 10, maxBatches: 3 });

    expect(result.examined).toBe(1);
    // A short batch is the last one.
    expect(result.done).toBe(true);
    expect(result.nextOffset).toBe(1);
  });
});
