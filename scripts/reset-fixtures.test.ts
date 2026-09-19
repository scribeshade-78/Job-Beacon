import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FIXTURE_POSTINGS,
  FIXTURE_SOURCE_CODE,
  inspectFixtures,
  resetFixtures,
  restoreFixturePostings,
} from "./reset-fixtures.js";

type Row = Record<string, unknown>;

function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * A filtering in-memory stand-in for the Supabase query builder.
 *
 * Written out rather than stubbed per call because this script DELETES DATA:
 * assertions about "what was removed" are only worth anything if the filters
 * that decided it were really applied. A mock that returned canned rows would
 * pass whether or not the scoping was correct.
 */
function makeClient(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  const deleted: Array<{ table: string; column: string; values: unknown[] }> = [];
  const updates: Array<{ table: string; payload: Row; column: string; values: unknown[] }> = [];

  const from = (table: string) => {
    if (!tables[table]) tables[table] = [];

    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "delete" | "update" = "select";
    let payload: Row = {};
    let countMode = false;
    let singleMode = false;
    let lastUpserted: Row | null = null;

    const matches = () => tables[table].filter((row) => filters.every((filter) => filter(row)));

    const builder: Record<string, unknown> = {
      select: (_columns?: string, options?: { count?: string; head?: boolean }) => {
        if (options?.count === "exact") countMode = true;
        return builder;
      },
      limit: () => builder,
      maybeSingle: () => {
        singleMode = true;
        return builder;
      },
      single: () => {
        singleMode = true;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      like: (column: string, pattern: string) => {
        const re = likeToRegExp(pattern);
        filters.push((row) => typeof row[column] === "string" && re.test(row[column] as string));
        return builder;
      },
      upsert: (rows: Row[] | Row, options?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        const list = Array.isArray(rows) ? rows : [rows];
        const conflictKey = options?.onConflict?.split(",") ?? [];
        for (const row of list) {
          // Mirrors ON CONFLICT (a, b) DO NOTHING, which is what makes the
          // restore idempotent.
          const exists = tables[table].some((existing) =>
            conflictKey.every((column) => existing[column] === row[column]),
          );
          const stored = { id: row.id ?? `generated-${table}-${tables[table].length + 1}`, ...row };
          if (!exists) tables[table].push(stored);
          // A real "upsert ... returning" hands back the row it wrote, which is
          // what restoreFixturePostings relies on to learn the company's id.
          lastUpserted = stored;
        }
        return builder;
      },
      delete: () => {
        mode = "delete";
        return builder;
      },
      update: (next: Row) => {
        mode = "update";
        payload = next;
        return builder;
      },
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            const hit = matches();

            if (mode === "delete") {
              deleted.push({ table, column: "filtered", values: [hit.length] });
              tables[table] = tables[table].filter((row) => !hit.includes(row));
              // Return what was removed: the script counts these rather than
              // the ids it asked for.
              return { data: hit.map((row) => ({ id: row.id })), error: null };
            }

            if (mode === "update") {
              updates.push({ table, payload, column: "filtered", values: [hit.length] });
              for (const row of hit) Object.assign(row, payload);
              return { data: null, error: null };
            }

            if (countMode) return { count: hit.length, data: null, error: null };
            if (singleMode) {
              // "upsert ... returning" answers with the written row; a plain
              // select answers with the first filtered row.
              const settled = lastUpserted ?? hit[0] ?? null;
              lastUpserted = null;
              return { data: settled, error: null };
            }
            return { data: hit, error: null };
          })
          .then(onFulfilled, onRejected),
    };

    return builder;
  };

  return {
    client: { from } as unknown as SupabaseClient,
    tables,
    deleted,
    updates,
    deletedRows: (table: string) => seed[table] && tables[table],
  };
}

const fixtureSeed = (): Record<string, Row[]> => ({
  vacancy_sources: [{ id: "vs-fixture", source_code: FIXTURE_SOURCE_CODE, target_key: "local-fixture-board" }],
  vacancies: [
    { id: "vac-fix-1", source_code: FIXTURE_SOURCE_CODE, company_id: "co-1" },
    { id: "vac-fix-2", source_code: FIXTURE_SOURCE_CODE, company_id: "co-2" },
    { id: "vac-real-1", source_code: "greenhouse", company_id: "co-1" },
  ],
  application_plans: [
    { id: "plan-1", vacancy_id: "vac-fix-1" },
    { id: "plan-2", vacancy_id: "vac-fix-2" },
    { id: "plan-real", vacancy_id: "vac-real-1" },
  ],
  application_attempts: [
    { id: "att-1", application_plan_id: "plan-1" },
    { id: "att-2", application_plan_id: "plan-2" },
    { id: "att-real", application_plan_id: "plan-real" },
  ],
  application_evidence: [
    { id: "ev-1", application_attempt_id: "att-1" },
    { id: "ev-real", application_attempt_id: "att-real" },
  ],
  action_required_events: [{ id: "ar-1", application_attempt_id: "att-1" }],
  messages: [
    { id: "msg-1", application_attempt_id: "att-1", subject: "Interview invitation" },
    { id: "msg-real", application_attempt_id: "att-real", subject: "Real one" },
  ],
  resume_documents: [
    { id: "doc-1", kind: "tailored", original_filename: "resume-mock-data-engineer-local-fixture-x.pdf" },
    { id: "doc-real", kind: "tailored", original_filename: "resume-acme-data-engineer.pdf" },
  ],
  companies: [{ id: "co-1" }, { id: "co-2" }],
});

describe("inspectFixtures", () => {
  it("collects exactly the fixture scope, leaving real postings alone", async () => {
    const { client } = makeClient(fixtureSeed());

    const inventory = await inspectFixtures(client);

    expect(inventory.vacancyIds.sort()).toEqual(["vac-fix-1", "vac-fix-2"]);
    expect(inventory.planIds.sort()).toEqual(["plan-1", "plan-2"]);
    expect(inventory.attemptIds.sort()).toEqual(["att-1", "att-2"]);
    expect(inventory.evidenceCount).toBe(1);
    expect(inventory.actionRequiredCount).toBe(1);
    expect(inventory.linkedMessageCount).toBe(1);
  });

  it("counts only tailored resumes from the fixture filename convention", async () => {
    const { client } = makeClient(fixtureSeed());

    const inventory = await inspectFixtures(client);

    // The candidate's real tailored resume for a real application is not
    // collateral damage of a fixture reset.
    expect(inventory.tailoredResumeCount).toBe(1);
  });

  it("returns an empty inventory when there are no fixtures", async () => {
    const { client } = makeClient({ vacancies: [], application_plans: [] });

    const inventory = await inspectFixtures(client);

    expect(inventory.vacancyIds).toEqual([]);
    expect(inventory.evidenceCount).toBe(0);
  });
});

describe("resetFixtures", () => {
  it("removes the fixture plans, attempts, evidence and vacancies", async () => {
    const { client, tables } = makeClient(fixtureSeed());

    const report = await resetFixtures(client);

    expect(tables.application_evidence.map((row) => row.id)).toEqual(["ev-real"]);
    expect(tables.action_required_events).toHaveLength(0);
    expect(tables.application_attempts.map((row) => row.id)).toEqual(["att-real"]);
    expect(tables.application_plans.map((row) => row.id)).toEqual(["plan-real"]);

    // Counted removals are what was actually removed, not the ids passed in.
    expect(report.deleted.application_evidence).toBe(1);
    expect(report.deleted.vacancies).toBe(2);

    // The old fixture vacancies are gone; the canonical ones are restored in
    // their place, and the real posting was never in scope.
    expect(tables.vacancies.map((row) => row.id)).not.toContain("vac-fix-1");
    expect(tables.vacancies.map((row) => row.id)).not.toContain("vac-fix-2");
    expect(tables.vacancies.map((row) => row.id)).toContain("vac-real-1");
  });

  it("unlinks matched messages instead of deleting the candidate's mail", async () => {
    const { client, tables } = makeClient(fixtureSeed());

    await resetFixtures(client);

    expect(tables.messages).toHaveLength(2);
    const fixtureMessage = tables.messages.find((row) => row.id === "msg-1");
    expect(fixtureMessage?.application_attempt_id).toBeNull();
    expect(tables.messages.find((row) => row.id === "msg-real")?.application_attempt_id).toBe("att-real");
  });

  it("deletes a company only once nothing else references it", async () => {
    const { client, tables } = makeClient(fixtureSeed());

    const report = await resetFixtures(client);

    // co-2 belonged only to a fixture; co-1 is still on a real vacancy.
    const remainingIds = tables.companies.map((row) => row.id);
    expect(remainingIds).toContain("co-1");
    expect(remainingIds).not.toContain("co-2");
    expect(report.deleted.companies).toBe(1);
  });

  it("gives the restored postings an employer, so a reply can be matched to them", async () => {
    // Without a company the application matcher has nothing to match an
    // employer email against, and the response loop can never close.
    const { client, tables } = makeClient(fixtureSeed());

    await resetFixtures(client);

    const employer = tables.companies.find((row) => row.displayed_name === "Local Fixture Employer");
    expect(employer?.domain).toBe("mock-employer.test");

    const fixtureVacancies = tables.vacancies.filter((row) => row.source_code === FIXTURE_SOURCE_CODE);
    for (const vacancy of fixtureVacancies) {
      expect(vacancy.company_id).toBe(employer?.id);
    }
  });

  it("keeps tailored resumes and says so, rather than orphaning their Storage objects", async () => {
    const { client, tables } = makeClient(fixtureSeed());

    const report = await resetFixtures(client);

    expect(tables.resume_documents).toHaveLength(2);
    expect(String(report.retained["resume_documents (tailored)"])).toContain("kept");
  });

  it("leaves the source configuration in place — it is not a fixture", async () => {
    const seed = fixtureSeed();
    seed.source_policies = [{ source_code: FIXTURE_SOURCE_CODE, discovery_allowed: true }];
    seed.vacancy_sources = [{ id: "vs-1", source_code: FIXTURE_SOURCE_CODE }];
    const { client, tables } = makeClient(seed);

    await resetFixtures(client);

    expect(tables.source_policies).toHaveLength(1);
    expect(tables.vacancy_sources).toHaveLength(1);
  });

  it("restores the canonical postings, so a reset is a reset and not a one-way door", async () => {
    const { client, tables } = makeClient(fixtureSeed());

    const report = await resetFixtures(client);

    expect(report.restored).toBe(FIXTURE_POSTINGS.length);
    const fixtureVacancies = tables.vacancies.filter((row) => row.source_code === FIXTURE_SOURCE_CODE);
    expect(fixtureVacancies.map((row) => row.source_vacancy_id).sort()).toEqual(
      FIXTURE_POSTINGS.map((posting) => posting.sourceVacancyId).sort(),
    );
    expect(report.remainingFixtureVacancies).toBe(FIXTURE_POSTINGS.length);
  });

  it("restores them as active and verified, so the pipeline can actually use them", async () => {
    const { client, tables } = makeClient(fixtureSeed());

    await resetFixtures(client);

    for (const row of tables.vacancies.filter((entry) => entry.source_code === FIXTURE_SOURCE_CODE)) {
      expect(row.status).toBe("active");
      expect(row.trust_status).toBe("VERIFIED");
      expect(String(row.authoritative_url)).toContain("/mock-employer/apply?posting=");
    }
  });

  it("does not duplicate postings when run twice — the whole point of a repeatable reset", async () => {
    const { client, tables } = makeClient(fixtureSeed());

    await resetFixtures(client);
    await resetFixtures(client);

    const fixtureVacancies = tables.vacancies.filter((row) => row.source_code === FIXTURE_SOURCE_CODE);
    expect(fixtureVacancies).toHaveLength(FIXTURE_POSTINGS.length);
  });

  it("leaves the real posting untouched across repeated resets", async () => {
    const { client, tables } = makeClient(fixtureSeed());

    await resetFixtures(client);
    await resetFixtures(client);

    expect(tables.vacancies.map((row) => row.id)).toContain("vac-real-1");
  });
});

describe("restoreFixturePostings", () => {
  it("refuses when the fixture source's configuration is missing, rather than inserting orphans", async () => {
    const { client } = makeClient({ vacancy_sources: [], vacancies: [] });

    await expect(restoreFixturePostings(client)).rejects.toThrow(/vacancy_sources row/);
  });
});
