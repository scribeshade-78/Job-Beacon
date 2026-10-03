import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_DECISIONS,
  decisionStateOf,
  dismissVacancy,
  excludedFromFeed,
  isDismissed,
  isSaved,
  listVacancyDecisions,
  saveVacancy,
  undoDismissal,
  unsaveVacancy,
  type VacancyDecisions,
} from "./jobDecisions";

/**
 * Save/Dismiss is candidate-owned state, so these tests pin the three things
 * that can silently break it: the exact payload the RLS WITH CHECK sees, the
 * PRECEDENCE rule (dismissal beats save), and that no Postgres message ever
 * reaches the candidate.
 */

function decisionsOf(saved: string[], dismissed: Array<[string, string]>): VacancyDecisions {
  return {
    savedIds: new Set(saved),
    dismissed: new Map(
      dismissed.map(([id, reason]) => [
        id,
        { vacancyId: id, reason: reason as never, note: null, dismissedAt: "2026-10-01T00:00:00Z" },
      ]),
    ),
  };
}

describe("precedence", () => {
  it("treats a vacancy with neither row as undecided", () => {
    expect(decisionStateOf(EMPTY_DECISIONS, "job-1")).toBe("none");
    expect(isSaved(EMPTY_DECISIONS, "job-1")).toBe(false);
    expect(isDismissed(EMPTY_DECISIONS, "job-1")).toBe(false);
  });

  it("reports saved and dismissed independently", () => {
    expect(decisionStateOf(decisionsOf(["job-1"], []), "job-1")).toBe("saved");
    expect(decisionStateOf(decisionsOf([], [["job-1", "not_interested"]]), "job-1")).toBe("dismissed");
  });

  it("DISMISSAL WINS when a vacancy is both saved and dismissed", () => {
    const decisions = decisionsOf(["job-1"], [["job-1", "wrong_role"]]);

    expect(decisionStateOf(decisions, "job-1")).toBe("saved_and_dismissed");
    // The load-bearing consequence: a dismissed-saved job is excluded, so it can
    // never silently return to the feed or to an automatic queue.
    expect(isDismissed(decisions, "job-1")).toBe(true);
    expect(excludedFromFeed(decisions)).toEqual(["job-1"]);
  });

  it("excludes only dismissed ids, in a stable order", () => {
    const decisions = decisionsOf(["job-1", "job-2"], [["job-3", "company"], ["job-2", "other"]]);

    expect(excludedFromFeed(decisions)).toEqual(["job-2", "job-3"]);
  });
});

interface TableResult {
  data?: unknown;
  error?: unknown;
}

function fakeClient(byTable: Record<string, TableResult>, options: { throw?: boolean } = {}) {
  const calls: Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }> = [];

  const client = {
    from: (table: string) => {
      const record: {
        table: string;
        op: string;
        payload?: unknown;
        filters: Array<[string, unknown]>;
      } = { table, op: "select", filters: [] };
      const result = byTable[table] ?? { data: null, error: null };

      const builder: any = {
        select: () => builder,
        insert: (payload: unknown) => {
          record.op = "insert";
          record.payload = payload;
          calls.push(record);
          return options.throw
            ? Promise.reject(new Error("network down"))
            : Promise.resolve(result);
        },
        delete: () => {
          record.op = "delete";
          calls.push(record);
          return builder;
        },
        eq: (column: string, value: unknown) => {
          record.filters.push([column, value]);
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => {
          calls.push(record);
          return Promise.resolve(result).then(resolve);
        },
      };

      return builder;
    },
  };

  return { client: client as never, calls };
}

describe("listVacancyDecisions", () => {
  it("maps both tables into sets and a dismissal map", async () => {
    const { client } = fakeClient({
      saved_vacancies: { data: [{ vacancy_id: "job-1" }, { vacancy_id: "job-2" }], error: null },
      dismissed_vacancies: {
        data: [
          { vacancy_id: "job-3", reason: "wrong_role", note: "not for me", dismissed_at: "2026-10-01T00:00:00Z" },
        ],
        error: null,
      },
    });

    const result = await listVacancyDecisions(client);

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect([...result.decisions.savedIds].sort()).toEqual(["job-1", "job-2"]);
    expect(result.decisions.dismissed.get("job-3")).toEqual({
      vacancyId: "job-3",
      reason: "wrong_role",
      note: "not for me",
      dismissedAt: "2026-10-01T00:00:00Z",
    });
  });

  it("treats an unrecognised reason as a dismissal rather than re-admitting the job", async () => {
    const { client } = fakeClient({
      saved_vacancies: { data: [], error: null },
      dismissed_vacancies: {
        data: [{ vacancy_id: "job-3", reason: "a_reason_from_the_future", note: null, dismissed_at: "x" }],
        error: null,
      },
    });

    const result = await listVacancyDecisions(client);

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.decisions.dismissed.get("job-3")?.reason).toBe("other");
  });

  it("returns one generic sentence on a query error", async () => {
    const { client } = fakeClient({
      saved_vacancies: { data: null, error: { message: 'relation "saved_vacancies" does not exist' } },
      dismissed_vacancies: { data: [], error: null },
    });

    const result = await listVacancyDecisions(client);

    expect(result).toEqual({ kind: "error", message: "Could not load your saved and dismissed jobs. Please try again." });
    expect(JSON.stringify(result)).not.toContain("relation");
  });
});

describe("save / unsave", () => {
  it("inserts the owning candidate and the vacancy", async () => {
    const { client, calls } = fakeClient({ saved_vacancies: { data: null, error: null } });

    expect(await saveVacancy(client, "candidate-1", "job-1")).toEqual({ kind: "success" });
    expect(calls[0]).toMatchObject({
      table: "saved_vacancies",
      op: "insert",
      payload: { candidate_id: "candidate-1", vacancy_id: "job-1" },
    });
  });

  it("treats an already-saved vacancy as success", async () => {
    const { client } = fakeClient({ saved_vacancies: { data: null, error: { code: "23505" } } });
    expect(await saveVacancy(client, "candidate-1", "job-1")).toEqual({ kind: "success" });
  });

  it("reports a generic failure on any other error, never the database text", async () => {
    const { client } = fakeClient({
      saved_vacancies: { data: null, error: { code: "42501", message: "new row violates row-level security policy" } },
    });

    const result = await saveVacancy(client, "candidate-1", "job-1");

    expect(result).toEqual({ kind: "error", message: "Could not update this job. Please try again." });
    expect(JSON.stringify(result)).not.toContain("row-level");
  });

  it("unsaves by vacancy id, leaving every other save alone", async () => {
    const { client, calls } = fakeClient({ saved_vacancies: { data: null, error: null } });

    expect(await unsaveVacancy(client, "job-1")).toEqual({ kind: "success" });
    expect(calls[0]?.op).toBe("delete");
    expect(calls[0]?.filters).toEqual([["vacancy_id", "job-1"]]);
  });
});

describe("dismiss / undo", () => {
  it("stores the reason and the optional note", async () => {
    const { client, calls } = fakeClient({ dismissed_vacancies: { data: null, error: null } });

    await dismissVacancy(client, "candidate-1", "job-1", "wrong_location", "  too far  ");

    expect(calls[0]).toMatchObject({
      table: "dismissed_vacancies",
      op: "insert",
      payload: { candidate_id: "candidate-1", vacancy_id: "job-1", reason: "wrong_location", note: "too far" },
    });
  });

  it("stores a blank note as null", async () => {
    const { client, calls } = fakeClient({ dismissed_vacancies: { data: null, error: null } });

    await dismissVacancy(client, "candidate-1", "job-1", "other", "   ");

    expect((calls[0]?.payload as { note: unknown }).note).toBeNull();
  });

  it("treats a repeated dismissal as success and does not rewrite the reason", async () => {
    const { client, calls } = fakeClient({ dismissed_vacancies: { data: null, error: { code: "23505" } } });

    expect(await dismissVacancy(client, "candidate-1", "job-1", "company", null)).toEqual({ kind: "success" });
    // An insert that the unique key refused changes nothing, so no update is issued.
    expect(calls.every((call) => call.op === "insert")).toBe(true);
  });

  it("undoes by vacancy id", async () => {
    const { client, calls } = fakeClient({ dismissed_vacancies: { data: null, error: null } });

    expect(await undoDismissal(client, "job-1")).toEqual({ kind: "success" });
    expect(calls[0]?.op).toBe("delete");
    expect(calls[0]?.filters).toEqual([["vacancy_id", "job-1"]]);
  });

  it("returns the generic sentence when the client throws", async () => {
    const { client } = fakeClient({ dismissed_vacancies: { data: null, error: null } }, { throw: true });

    expect(await dismissVacancy(client, "candidate-1", "job-1", "other", null)).toEqual({
      kind: "error",
      message: "Could not update this job. Please try again.",
    });
  });
});
