import { describe, expect, it, vi } from "vitest";
import { getRecentTrustScores } from "./trustScores.js";

const row = {
  id: "score-1",
  vacancy_id: "vacancy-1",
  status: "FLAGGED",
  score: 42,
  policy_version: "r3-trust-score-v1",
  scored_at: "2026-08-16T00:00:00Z",
  vacancies: { raw_title: "Backend Engineer" },
};

function makeClient(result: { data: unknown; error: unknown }, limitSpy?: (limit: number) => void) {
  const from = vi.fn(() => ({
    select: () => ({
      order: () => ({
        limit: (limit: number) => {
          limitSpy?.(limit);
          return result;
        },
      }),
    }),
  }));
  return { from } as unknown as Parameters<typeof getRecentTrustScores>[0];
}

describe("getRecentTrustScores", () => {
  it("maps rows to camelCase entries with vacancy title", async () => {
    const client = makeClient({ data: [row], error: null });

    await expect(getRecentTrustScores(client)).resolves.toEqual([
      {
        id: "score-1",
        vacancyId: "vacancy-1",
        vacancyTitle: "Backend Engineer",
        status: "FLAGGED",
        score: 42,
        policyVersion: "r3-trust-score-v1",
        scoredAt: "2026-08-16T00:00:00Z",
      },
    ]);
  });

  it("falls back to an empty title when the vacancy join is null", async () => {
    const client = makeClient({ data: [{ ...row, vacancies: null }], error: null });

    const [entry] = await getRecentTrustScores(client);
    expect(entry.vacancyTitle).toBe("");
  });

  it("defaults the limit to 50", async () => {
    let capturedLimit: number | undefined;
    const client = makeClient({ data: [], error: null }, (limit) => {
      capturedLimit = limit;
    });

    await getRecentTrustScores(client);
    expect(capturedLimit).toBe(50);
  });

  it("passes through a custom limit", async () => {
    let capturedLimit: number | undefined;
    const client = makeClient({ data: [], error: null }, (limit) => {
      capturedLimit = limit;
    });

    await getRecentTrustScores(client, 10);
    expect(capturedLimit).toBe(10);
  });

  it("returns an empty array when there are no rows", async () => {
    const client = makeClient({ data: null, error: null });
    await expect(getRecentTrustScores(client)).resolves.toEqual([]);
  });

  it("throws when the query errors", async () => {
    const client = makeClient({ data: null, error: { message: "db error" } });
    await expect(getRecentTrustScores(client)).rejects.toBeTruthy();
  });
});
