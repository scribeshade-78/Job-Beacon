import { describe, expect, it, vi } from "vitest";
import { applyHardBlocks } from "./applyHardBlocks.js";
import type { HardBlockSignals } from "./hardBlocks.js";

const cleanSignals: HardBlockSignals = {
  authoritativeUrl: "https://careers.acme.com/jobs/123",
  companyDomain: "acme.com",
  companyCareerDomain: "careers.acme.com",
  sourceDiscoveryAllowed: true,
  sourceKillSwitch: false,
  vacancyStatus: "active",
};

/**
 * A minimal chainable query-builder double, matching the pattern already
 * used in server/ingestion/ingest.test.ts: every non-terminal method
 * returns `this` so `.insert().select().single()` chains freely, `single()`
 * returns the configured result directly, and the builder is itself
 * thenable so a bare `await client.from(...).insert(...)` (no further
 * chaining) also resolves to the configured result.
 */
function makeBuilder(terminalResult: { data: unknown; error: unknown } = { data: null, error: null }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain = (method: string) => (...args: unknown[]) => (calls.push({ method, args }), builder);
  const terminal = (method: string) => (...args: unknown[]) => (calls.push({ method, args }), terminalResult);

  const builder = {
    calls,
    insert: chain("insert"),
    update: chain("update"),
    select: chain("select"),
    eq: chain("eq"),
    single: terminal("single"),
    then: (resolve: (v: unknown) => void) => resolve(terminalResult),
  };

  return builder;
}

describe("applyHardBlocks", () => {
  it("does nothing and returns blocked:false when no hard block fires", async () => {
    const from = vi.fn(() => makeBuilder());
    const client = { from } as unknown as Parameters<typeof applyHardBlocks>[0];

    const result = await applyHardBlocks(client, "vacancy-1", cleanSignals);

    expect(result).toEqual({ blocked: false, reasonCodes: [] });
    expect(from).not.toHaveBeenCalled();
  });

  it("records a BLOCKED trust score, a flag row, and updates trust_status when a hard block fires", async () => {
    const trustScoreBuilder = makeBuilder({ data: { id: "score-1" }, error: null });
    const flagsBuilder = makeBuilder({ data: null, error: null });
    const vacanciesBuilder = makeBuilder({ data: null, error: null });

    const from = vi.fn((table: string) => {
      if (table === "vacancy_trust_scores") return trustScoreBuilder;
      if (table === "vacancy_flags") return flagsBuilder;
      if (table === "vacancies") return vacanciesBuilder;
      throw new Error(`Unexpected table: ${table}`);
    });
    const client = { from } as unknown as Parameters<typeof applyHardBlocks>[0];

    const signals: HardBlockSignals = { ...cleanSignals, vacancyStatus: "removed" };
    const result = await applyHardBlocks(client, "vacancy-1", signals);

    expect(result).toEqual({ blocked: true, reasonCodes: ["VACANCY_REMOVED"] });

    expect(trustScoreBuilder.calls[0]).toEqual({
      method: "insert",
      args: [{ vacancy_id: "vacancy-1", status: "BLOCKED", score: null, policy_version: "r3-hard-block-v1" }],
    });

    expect(flagsBuilder.calls[0]).toEqual({
      method: "insert",
      args: [[{ vacancy_trust_score_id: "score-1", reason_code: "VACANCY_REMOVED" }]],
    });

    expect(vacanciesBuilder.calls[0]).toEqual({ method: "update", args: [{ trust_status: "BLOCKED" }] });
    expect(vacanciesBuilder.calls[1]).toEqual({ method: "eq", args: ["id", "vacancy-1"] });
  });

  it("inserts one flag row per triggered reason code", async () => {
    const trustScoreBuilder = makeBuilder({ data: { id: "score-1" }, error: null });
    const flagsBuilder = makeBuilder({ data: null, error: null });
    const vacanciesBuilder = makeBuilder({ data: null, error: null });

    const from = vi.fn((table: string) => {
      if (table === "vacancy_trust_scores") return trustScoreBuilder;
      if (table === "vacancy_flags") return flagsBuilder;
      if (table === "vacancies") return vacanciesBuilder;
      throw new Error(`Unexpected table: ${table}`);
    });
    const client = { from } as unknown as Parameters<typeof applyHardBlocks>[0];

    const signals: HardBlockSignals = {
      ...cleanSignals,
      vacancyStatus: "removed",
      sourceKillSwitch: true,
    };
    const result = await applyHardBlocks(client, "vacancy-1", signals);

    expect(result.blocked).toBe(true);
    expect(result.reasonCodes).toEqual(["VACANCY_REMOVED", "UNAUTHORIZED_SOURCE_ACCESS"]);

    const insertedFlags = flagsBuilder.calls[0].args[0] as Array<{ vacancy_trust_score_id: string; reason_code: string }>;
    expect(insertedFlags).toHaveLength(2);
    expect(insertedFlags.every((flag) => flag.vacancy_trust_score_id === "score-1")).toBe(true);
  });

  it("throws when the trust score insert fails, without writing flags or updating the vacancy", async () => {
    const trustScoreBuilder = makeBuilder({ data: null, error: { message: "insert failed" } });
    const flagsFrom = vi.fn();

    const from = vi.fn((table: string) => {
      if (table === "vacancy_trust_scores") return trustScoreBuilder;
      flagsFrom(table);
      throw new Error(`Unexpected table: ${table}`);
    });
    const client = { from } as unknown as Parameters<typeof applyHardBlocks>[0];

    const signals: HardBlockSignals = { ...cleanSignals, vacancyStatus: "removed" };

    await expect(applyHardBlocks(client, "vacancy-1", signals)).rejects.toBeTruthy();
    expect(flagsFrom).not.toHaveBeenCalled();
  });
});
