import { describe, expect, it, vi } from "vitest";
import { getModerationQueue } from "./queue.js";

const caseRows = [
  {
    id: "case-low",
    vacancy_id: "vacancy-low",
    source_type: "rule",
    severity: "low",
    evidence_snapshot: {},
    created_at: "2026-08-17T00:00:00Z",
    vacancies: { raw_title: "Low severity role", authoritative_url: "https://acme.example/jobs/low" },
  },
  {
    id: "case-critical-newer",
    vacancy_id: "vacancy-critical-newer",
    source_type: "candidate_report",
    severity: "critical",
    evidence_snapshot: { flagged: true },
    created_at: "2026-08-17T02:00:00Z",
    vacancies: { raw_title: "Critical newer role", authoritative_url: "https://acme.example/jobs/critical-new" },
  },
  {
    id: "case-critical-older",
    vacancy_id: "vacancy-critical-older",
    source_type: "rule",
    severity: "critical",
    evidence_snapshot: { flagged: true },
    created_at: "2026-08-17T01:00:00Z",
    vacancies: { raw_title: "Critical older role", authoritative_url: "https://acme.example/jobs/critical-old" },
  },
  {
    id: "case-already-decided",
    vacancy_id: "vacancy-decided",
    source_type: "rule",
    severity: "critical",
    evidence_snapshot: {},
    created_at: "2026-08-16T00:00:00Z",
    vacancies: { raw_title: "Already decided role", authoritative_url: "https://acme.example/jobs/decided" },
  },
];

function makeClient(overrides: { casesResult?: { data: unknown; error: unknown }; decisionsResult?: { data: unknown; error: unknown } } = {}) {
  const from = vi.fn((table: string) => {
    if (table === "moderation_cases") {
      const result = overrides.casesResult ?? { data: caseRows, error: null };
      return { select: () => result };
    }
    if (table === "moderation_decisions") {
      const result = overrides.decisionsResult ?? { data: [{ moderation_case_id: "case-already-decided" }], error: null };
      return { select: () => result };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  return { from } as unknown as Parameters<typeof getModerationQueue>[0];
}

describe("getModerationQueue", () => {
  it("excludes cases that already have a decision", async () => {
    const client = makeClient();
    const queue = await getModerationQueue(client);
    expect(queue.map((entry) => entry.caseId)).not.toContain("case-already-decided");
    expect(queue).toHaveLength(3);
  });

  it("orders by severity (critical first), then oldest-first within a tier", async () => {
    const client = makeClient();
    const queue = await getModerationQueue(client);
    expect(queue.map((entry) => entry.caseId)).toEqual(["case-critical-older", "case-critical-newer", "case-low"]);
  });

  it("includes the frozen evidence snapshot and vacancy context", async () => {
    const client = makeClient();
    const queue = await getModerationQueue(client);
    const critical = queue.find((entry) => entry.caseId === "case-critical-older")!;
    expect(critical.evidenceSnapshot).toEqual({ flagged: true });
    expect(critical.vacancyTitle).toBe("Critical older role");
    expect(critical.vacancyUrl).toBe("https://acme.example/jobs/critical-old");
  });

  it("throws when fetching cases errors", async () => {
    const client = makeClient({ casesResult: { data: null, error: { message: "db error" } } });
    await expect(getModerationQueue(client)).rejects.toBeTruthy();
  });

  it("throws when fetching decisions errors", async () => {
    const client = makeClient({ decisionsResult: { data: null, error: { message: "db error" } } });
    await expect(getModerationQueue(client)).rejects.toBeTruthy();
  });

  it("returns an empty queue when there are no cases", async () => {
    const client = makeClient({ casesResult: { data: [], error: null }, decisionsResult: { data: [], error: null } });
    await expect(getModerationQueue(client)).resolves.toEqual([]);
  });
});
