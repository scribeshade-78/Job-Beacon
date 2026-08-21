import { describe, expect, it, vi } from "vitest";
import { submitVacancyReport } from "./reports.js";

type TableResult = { data: unknown; error: unknown };

/**
 * Per-table fake query builder — needed now that submitVacancyReport
 * touches two tables (vacancy_reports, then vacancies), unlike the
 * single-builder mock this file used before. `.eq()`/`.in()` are no-ops
 * that return the same builder so any number of chained calls works; the
 * builder itself is thenable so the vacancies update (which doesn't chain
 * `.select().single()`, just awaits the builder directly) resolves to
 * `result` without requiring a `.single()` call.
 */
function chain(result: TableResult) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  const builder: Record<string, unknown> & PromiseLike<TableResult> & { calls: typeof calls } = {
    calls,
    insert: record("insert"),
    select: record("select"),
    update: record("update"),
    eq: record("eq"),
    in: record("in"),
    single: (...args: unknown[]) => {
      calls.push({ method: "single", args });
      return result;
    },
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as Record<string, unknown> & PromiseLike<TableResult> & { calls: typeof calls };
  return builder;
}

/**
 * One builder per table, memoized by name — so a test can inspect
 * `builders.vacancy_reports.calls` and `builders.vacancies.calls`
 * separately, and `from.mock.calls.map((c) => c[0])` shows exactly which
 * tables were touched (used to prove no moderation_cases/vacancy_trust_scores/
 * companies/source_policies query — i.e. no case creation, no synchronous
 * scoreVacancy — ever happens).
 */
function makeClient(overrides: Partial<Record<string, TableResult>> = {}) {
  const results: Record<string, TableResult> = {
    vacancy_reports: { data: { id: "report-1" }, error: null },
    vacancies: { data: null, error: null },
    ...overrides,
  };
  const builders: Record<string, ReturnType<typeof chain>> = {};
  const from = vi.fn((table: string) => {
    if (!builders[table]) {
      builders[table] = chain(results[table]);
    }
    return builders[table];
  });
  const client = { from } as unknown as Parameters<typeof submitVacancyReport>[0];

  return { client, from, builders };
}

const baseInput = {
  vacancyId: "vacancy-1",
  reporterId: "reporter-1",
  category: "fake_job" as const,
};

describe("submitVacancyReport", () => {
  it("inserts a report with the given reporterId and returns its id", async () => {
    const { client, from, builders } = makeClient();

    const result = await submitVacancyReport(client, {
      vacancyId: "vacancy-1",
      reporterId: "reporter-1",
      category: "payment_request",
      description: "Asked for a fee.",
    });

    expect(result).toEqual({ id: "report-1" });
    expect(from).toHaveBeenCalledWith("vacancy_reports");
    expect(builders.vacancy_reports.calls[0]).toEqual({
      method: "insert",
      args: [
        {
          vacancy_id: "vacancy-1",
          reporter_id: "reporter-1",
          category: "payment_request",
          description: "Asked for a fee.",
        },
      ],
    });
  });

  it("defaults description to null when omitted", async () => {
    const { client, builders } = makeClient();

    await submitVacancyReport(client, baseInput);

    expect((builders.vacancy_reports.calls[0].args[0] as { description: unknown }).description).toBeNull();
  });

  it("throws when the insert errors, and never touches vacancies at all", async () => {
    const { client, from } = makeClient({ vacancy_reports: { data: null, error: { message: "insert failed" } } });

    await expect(submitVacancyReport(client, baseInput)).rejects.toBeTruthy();
    expect(from).not.toHaveBeenCalledWith("vacancies");
  });

  describe("trust-status demotion", () => {
    it(
      "conditions the demotion update on trust_status being VERIFIED or VERIFIED_INCOMPLETE, scoped to the " +
        "reported vacancy — the same WHERE-clause-decides discipline used elsewhere in this repo. This single " +
        "conditional filter is what causes a VERIFIED or VERIFIED_INCOMPLETE vacancy to demote to UNDER_REVIEW " +
        "while an already-UNDER_REVIEW, FLAGGED, BLOCKED, EXPIRED_REMOVED, ACTION_REQUIRED, or unscored (null) " +
        "vacancy is left untouched by the same call — a real conditional-transition-per-starting-status " +
        "assertion needs a pgTAP/integration test against real Postgres, which is outside this mini-phase's " +
        "authorized file scope (server/reports.ts + server/reports.test.ts only).",
      async () => {
        const { client, from, builders } = makeClient();

        await submitVacancyReport(client, baseInput);

        expect(from).toHaveBeenCalledWith("vacancies");
        expect(builders.vacancies.calls).toEqual([
          { method: "update", args: [{ trust_status: "UNDER_REVIEW" }] },
          { method: "eq", args: ["id", "vacancy-1"] },
          { method: "in", args: ["trust_status", ["VERIFIED", "VERIFIED_INCOMPLETE"]] },
        ]);
      },
    );

    it("scopes the update to the specific reported vacancy id, not every vacancy", async () => {
      const { client, builders } = makeClient();

      await submitVacancyReport(client, { ...baseInput, vacancyId: "vacancy-42" });

      expect(builders.vacancies.calls).toContainEqual({ method: "eq", args: ["id", "vacancy-42"] });
    });

    it("does not insert a moderation_cases row", async () => {
      const { client, from } = makeClient();

      await submitVacancyReport(client, baseInput);

      expect(from).not.toHaveBeenCalledWith("moderation_cases");
    });

    it("does not call scoreVacancy synchronously — touches only vacancy_reports and vacancies, nothing scoreVacancy itself reads (vacancy_trust_scores, vacancy_flags, companies, source_policies)", async () => {
      const { client, from } = makeClient();

      await submitVacancyReport(client, baseInput);

      const touchedTables = from.mock.calls.map((call) => call[0]);
      expect(touchedTables).toEqual(["vacancy_reports", "vacancies"]);
    });

    it("still returns the report id even though a demotion update was also issued", async () => {
      const { client } = makeClient();

      const result = await submitVacancyReport(client, baseInput);

      expect(result).toEqual({ id: "report-1" });
    });

    it(
      "throws when the demotion update itself errors — the same 'two separate writes, throw on the second " +
        "one's failure' convention actionRequired.ts's createActionRequiredEvent already uses, even though the " +
        "report insert above it has already durably committed and is not rolled back",
      async () => {
        const { client, builders } = makeClient({
          vacancies: { data: null, error: { message: "update failed" } },
        });

        await expect(submitVacancyReport(client, baseInput)).rejects.toBeTruthy();

        // The report insert still happened before the demotion update failed —
        // a torn write (report recorded, demotion not applied), not a lost report.
        expect(builders.vacancy_reports.calls.some((call) => call.method === "insert")).toBe(true);
      },
    );
  });
});
