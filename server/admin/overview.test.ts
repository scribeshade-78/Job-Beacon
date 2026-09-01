import { describe, expect, it, vi } from "vitest";
import { getAdminOverview } from "./overview.js";

function makeClient(overrides: {
  casesResult?: { data: unknown; error: unknown };
  decisionsResult?: { data: unknown; error: unknown };
  sourcesResult?: { data: unknown; error: unknown; count: number | null };
  candidatesResult?: { data: unknown; error: unknown; count: number | null };
} = {}) {
  const sourcesResult = overrides.sourcesResult ?? { data: null, error: null, count: 3 };
  const candidatesResult = overrides.candidatesResult ?? { data: null, error: null, count: 12 };

  const from = vi.fn((table: string) => {
    if (table === "moderation_cases") {
      return { select: () => overrides.casesResult ?? { data: [], error: null } };
    }
    if (table === "moderation_decisions") {
      return { select: () => overrides.decisionsResult ?? { data: [], error: null } };
    }
    if (table === "source_policies") {
      return { select: () => ({ eq: () => sourcesResult }) };
    }
    if (table === "candidate_profiles") {
      return { select: () => candidatesResult };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  return { from } as unknown as Parameters<typeof getAdminOverview>[0];
}

describe("getAdminOverview", () => {
  it("returns the three real counts", async () => {
    const client = makeClient();
    await expect(getAdminOverview(client)).resolves.toEqual({
      openModerationCases: 0,
      activeSources: 3,
      totalCandidates: 12,
    });
  });

  it("counts open moderation cases via getModerationQueue's own open-case logic", async () => {
    const client = makeClient({
      casesResult: {
        data: [
          { id: "case-1", vacancy_id: "v-1", source_type: "rule", severity: "low", evidence_snapshot: {}, created_at: "2026-08-17T00:00:00Z", vacancies: null },
          { id: "case-2", vacancy_id: "v-2", source_type: "rule", severity: "low", evidence_snapshot: {}, created_at: "2026-08-17T00:00:00Z", vacancies: null },
        ],
        error: null,
      },
      decisionsResult: { data: [{ moderation_case_id: "case-2" }], error: null },
    });

    await expect(getAdminOverview(client)).resolves.toMatchObject({ openModerationCases: 1 });
  });

  it("treats a null count as 0", async () => {
    const client = makeClient({
      sourcesResult: { data: null, error: null, count: null },
      candidatesResult: { data: null, error: null, count: null },
    });

    await expect(getAdminOverview(client)).resolves.toEqual({
      openModerationCases: 0,
      activeSources: 0,
      totalCandidates: 0,
    });
  });

  it("throws when the sources count query errors", async () => {
    const client = makeClient({ sourcesResult: { data: null, error: { message: "db error" }, count: null } });
    await expect(getAdminOverview(client)).rejects.toBeTruthy();
  });

  it("throws when the candidates count query errors", async () => {
    const client = makeClient({ candidatesResult: { data: null, error: { message: "db error" }, count: null } });
    await expect(getAdminOverview(client)).rejects.toBeTruthy();
  });

  it("throws when the moderation queue query errors", async () => {
    const client = makeClient({ casesResult: { data: null, error: { message: "db error" } } });
    await expect(getAdminOverview(client)).rejects.toBeTruthy();
  });
});
