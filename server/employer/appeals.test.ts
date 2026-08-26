import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  DuplicatePendingAppealError,
  UnverifiedEmployerError,
  VacancyNotFoundError,
  getAppealsQueue,
  listEmployerBlockedVacancies,
  submitVacancyAppeal,
} from "./appeals.js";

/**
 * Each queued response corresponds to exactly one `.from(table)` call, in
 * the exact order the function under test makes them — verified against
 * appeals.ts's own implementation. The builder is a thenable so a bare
 * `await client.from(...).select().eq()` resolves it directly, and also
 * exposes maybeSingle()/single() resolving to the same queued result.
 */
function makeSequencedClient(responses: Array<{ data: unknown; error: unknown }>) {
  let index = 0;
  const fromCalls: string[] = [];
  const insertCalls: Array<{ table: string; payload: unknown }> = [];

  const from = vi.fn((table: string) => {
    fromCalls.push(table);
    const result = responses[index] ?? { data: null, error: null };
    index += 1;

    const builder: {
      select: (...args: unknown[]) => typeof builder;
      insert: (payload: unknown) => typeof builder;
      eq: (...args: unknown[]) => typeof builder;
      in: (...args: unknown[]) => typeof builder;
      order: (...args: unknown[]) => typeof builder;
      limit: (...args: unknown[]) => typeof builder;
      maybeSingle: () => Promise<typeof result>;
      single: () => Promise<typeof result>;
      then: (resolve: (value: typeof result) => void) => void;
    } = {
      select: vi.fn(() => builder),
      insert: vi.fn((payload: unknown) => {
        insertCalls.push({ table, payload });
        return builder;
      }),
      eq: vi.fn(() => builder),
      in: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => result),
      single: vi.fn(async () => result),
      then: (resolve) => resolve(result),
    };

    return builder;
  });

  const client = { from } as unknown as SupabaseClient;
  return { client, from, fromCalls, insertCalls };
}

const ok = (data: unknown) => ({ data, error: null });

describe("listEmployerBlockedVacancies", () => {
  it("returns an empty list when there are no blocked vacancies", async () => {
    const { client } = makeSequencedClient([ok([])]);
    expect(await listEmployerBlockedVacancies(client, "company-1")).toEqual([]);
  });

  it("maps a blocked vacancy to its latest decision", async () => {
    const { client } = makeSequencedClient([
      ok([{ id: "vacancy-1", raw_title: "Backend Engineer", authoritative_url: "https://x.test/1" }]),
      ok([{ id: "case-1", vacancy_id: "vacancy-1" }]),
      ok([{ id: "decision-1", moderation_case_id: "case-1", rationale: "Scam pattern.", policy_version: "v1", created_at: "2026-08-20T00:00:00.000Z" }]),
      ok([]), // findVacancyIdsWithPendingAppeal: no employer_appeal cases
    ]);

    const result = await listEmployerBlockedVacancies(client, "company-1");

    expect(result).toEqual([
      {
        vacancyId: "vacancy-1",
        title: "Backend Engineer",
        url: "https://x.test/1",
        decisionId: "decision-1",
        decisionRationale: "Scam pattern.",
        decisionPolicyVersion: "v1",
        decisionCreatedAt: "2026-08-20T00:00:00.000Z",
        hasPendingAppeal: false,
      },
    ]);
  });

  it("picks the most recent decision across multiple cases for the same vacancy", async () => {
    const { client } = makeSequencedClient([
      ok([{ id: "vacancy-1", raw_title: "Backend Engineer", authoritative_url: "https://x.test/1" }]),
      ok([
        { id: "case-old", vacancy_id: "vacancy-1" },
        { id: "case-new", vacancy_id: "vacancy-1" },
      ]),
      ok([
        { id: "decision-new", moderation_case_id: "case-new", rationale: "Latest.", policy_version: "v2", created_at: "2026-08-25T00:00:00.000Z" },
        { id: "decision-old", moderation_case_id: "case-old", rationale: "Older.", policy_version: "v1", created_at: "2026-08-20T00:00:00.000Z" },
      ]),
      ok([]),
    ]);

    const result = await listEmployerBlockedVacancies(client, "company-1");
    expect(result[0].decisionId).toBe("decision-new");
  });

  it("marks hasPendingAppeal true when an undecided employer_appeal case exists", async () => {
    const { client } = makeSequencedClient([
      ok([{ id: "vacancy-1", raw_title: "Backend Engineer", authoritative_url: "https://x.test/1" }]),
      ok([{ id: "case-1", vacancy_id: "vacancy-1" }]),
      ok([{ id: "decision-1", moderation_case_id: "case-1", rationale: "r", policy_version: "v1", created_at: "2026-08-20T00:00:00.000Z" }]),
      ok([{ id: "appeal-case-1", vacancy_id: "vacancy-1" }]),
      ok([]), // no decisions on that appeal case yet — still pending
    ]);

    const result = await listEmployerBlockedVacancies(client, "company-1");
    expect(result[0].hasPendingAppeal).toBe(true);
  });

  it("excludes a blocked vacancy with no findable decision", async () => {
    const { client } = makeSequencedClient([
      ok([{ id: "vacancy-1", raw_title: "Backend Engineer", authoritative_url: "https://x.test/1" }]),
      ok([]), // no moderation_cases at all
      ok([]),
    ]);

    expect(await listEmployerBlockedVacancies(client, "company-1")).toEqual([]);
  });
});

describe("submitVacancyAppeal", () => {
  const baseInput = { userId: "user-1", companyId: "company-1", vacancyId: "vacancy-1", rationale: "False positive." };

  it("throws UnverifiedEmployerError when no verified claim exists", async () => {
    const { client } = makeSequencedClient([ok(null)]);
    await expect(submitVacancyAppeal(client, baseInput)).rejects.toBeInstanceOf(UnverifiedEmployerError);
  });

  it("throws VacancyNotFoundError when the vacancy belongs to a different company", async () => {
    const { client } = makeSequencedClient([
      ok({ id: "claim-1" }),
      ok({ id: "vacancy-1", company_id: "some-other-company" }),
    ]);
    await expect(submitVacancyAppeal(client, baseInput)).rejects.toBeInstanceOf(VacancyNotFoundError);
  });

  it("throws VacancyNotFoundError when the vacancy has no moderation case", async () => {
    const { client } = makeSequencedClient([
      ok({ id: "claim-1" }),
      ok({ id: "vacancy-1", company_id: "company-1" }),
      ok([]),
    ]);
    await expect(submitVacancyAppeal(client, baseInput)).rejects.toBeInstanceOf(VacancyNotFoundError);
  });

  it("throws DuplicatePendingAppealError when an appeal is already pending for this vacancy", async () => {
    const { client } = makeSequencedClient([
      ok({ id: "claim-1" }),
      ok({ id: "vacancy-1", company_id: "company-1" }),
      ok([{ id: "case-1", severity: "high" }]),
      ok([{ id: "decision-1", moderation_case_id: "case-1" }]),
      ok([{ id: "appeal-case-1", vacancy_id: "vacancy-1" }]),
      ok([]), // no decision on the appeal case — still pending
    ]);
    await expect(submitVacancyAppeal(client, baseInput)).rejects.toBeInstanceOf(DuplicatePendingAppealError);
  });

  it("on the happy path, inserts the appeal then a linked employer_appeal case with inherited severity", async () => {
    const { client, insertCalls } = makeSequencedClient([
      ok({ id: "claim-1" }),
      ok({ id: "vacancy-1", company_id: "company-1" }),
      ok([{ id: "case-1", severity: "high" }]),
      ok([{ id: "decision-1", moderation_case_id: "case-1" }]),
      ok([]), // no employer_appeal cases at all
      ok({ id: "appeal-1" }), // vacancy_appeals insert().select().single()
      ok({ error: null }), // moderation_cases insert
    ]);

    const result = await submitVacancyAppeal(client, baseInput);

    expect(result).toEqual({ id: "appeal-1" });
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0].table).toBe("vacancy_appeals");
    expect(insertCalls[0].payload).toMatchObject({ moderation_decision_id: "decision-1", filer_id: "user-1", rationale: "False positive." });
    const evidenceDeadline = (insertCalls[0].payload as { evidence_deadline: string }).evidence_deadline;
    expect(new Date(evidenceDeadline).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);

    expect(insertCalls[1].table).toBe("moderation_cases");
    expect(insertCalls[1].payload).toMatchObject({
      vacancy_id: "vacancy-1",
      source_type: "employer_appeal",
      severity: "high",
      appeal_id: "appeal-1",
    });
  });
});

describe("getAppealsQueue", () => {
  it("returns an empty list when there are no employer_appeal cases", async () => {
    const { client } = makeSequencedClient([ok([])]);
    expect(await getAppealsQueue(client)).toEqual([]);
  });

  it("excludes cases that already have a decision", async () => {
    const { client } = makeSequencedClient([
      ok([{ id: "case-1", vacancy_id: "vacancy-1", appeal_id: "appeal-1", created_at: "2026-08-26T00:00:00.000Z", vacancies: { raw_title: "t", authoritative_url: "u" } }]),
      ok([{ moderation_case_id: "case-1" }]), // decided
    ]);
    expect(await getAppealsQueue(client)).toEqual([]);
  });

  it("maps an open appeal case with the appeal detail and the original decision", async () => {
    const { client } = makeSequencedClient([
      ok([
        {
          id: "case-1",
          vacancy_id: "vacancy-1",
          appeal_id: "appeal-1",
          created_at: "2026-08-26T00:00:00.000Z",
          vacancies: { raw_title: "Backend Engineer", authoritative_url: "https://x.test/1" },
        },
      ]),
      ok([]), // no decisions yet — open
      ok([{ id: "appeal-1", moderation_decision_id: "decision-1", rationale: "False positive.", evidence: { text: "DNS proof" }, evidence_deadline: "2026-09-02T00:00:00.000Z" }]),
      ok([{ id: "decision-1", rationale: "Confirmed scam pattern.", policy_version: "v1" }]),
    ]);

    const result = await getAppealsQueue(client);

    expect(result).toEqual([
      {
        caseId: "case-1",
        appealId: "appeal-1",
        vacancyId: "vacancy-1",
        vacancyTitle: "Backend Engineer",
        vacancyUrl: "https://x.test/1",
        appealRationale: "False positive.",
        appealEvidence: { text: "DNS proof" },
        evidenceDeadline: "2026-09-02T00:00:00.000Z",
        originalDecisionId: "decision-1",
        originalDecisionRationale: "Confirmed scam pattern.",
        originalDecisionPolicyVersion: "v1",
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ]);
  });
});
