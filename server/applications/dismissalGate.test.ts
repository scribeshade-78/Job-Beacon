import { describe, expect, it, vi } from "vitest";
import { evaluateDismissal, isVacancyDismissed } from "./dismissalGate.js";

/**
 * The gate must SCOPE BY CANDIDATE. RLS does not apply to the service-role
 * client this runs on, so a dropped candidate_id predicate would silently turn
 * "did THIS candidate dismiss it" into "did ANYBODY dismiss it" — a
 * cross-candidate leak that blocks other people's applications. The assertion
 * on the emitted filters is the regression guard for that.
 */

function makeClient(result: { data: unknown; error: unknown }) {
  const filters: Array<[string, unknown]> = [];
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    }),
    maybeSingle: vi.fn(async () => result),
  };
  const client = { from: vi.fn(() => builder) } as never;
  return { client, filters };
}

describe("isVacancyDismissed", () => {
  it("scopes the query to the candidate and the vacancy", async () => {
    const { client, filters } = makeClient({ data: null, error: null });

    await isVacancyDismissed(client, "candidate-1", "vacancy-1");

    expect(filters).toEqual([
      ["candidate_id", "candidate-1"],
      ["vacancy_id", "vacancy-1"],
    ]);
  });

  it("is true only when a row exists", async () => {
    expect(await isVacancyDismissed(makeClient({ data: null, error: null }).client, "c", "v")).toBe(false);
    expect(
      await isVacancyDismissed(makeClient({ data: { vacancy_id: "v" }, error: null }).client, "c", "v"),
    ).toBe(true);
  });

  it("throws on a query error rather than reporting 'not dismissed'", async () => {
    const { client } = makeClient({ data: null, error: { message: "down" } });
    await expect(isVacancyDismissed(client, "c", "v")).rejects.toBeTruthy();
  });
});

describe("evaluateDismissal", () => {
  it("passes when there is no dismissal", async () => {
    const { client } = makeClient({ data: null, error: null });
    expect(await evaluateDismissal(client, "c", "v")).toEqual({ status: "pass" });
  });

  it("fails with VACANCY_DISMISSED and the vacancy as evidence", async () => {
    const { client } = makeClient({ data: { vacancy_id: "vacancy-1" }, error: null });
    expect(await evaluateDismissal(client, "c", "vacancy-1")).toEqual({
      status: "fail",
      reasonCode: "VACANCY_DISMISSED",
      detail: { vacancyId: "vacancy-1" },
    });
  });
});
