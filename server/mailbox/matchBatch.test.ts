import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runApplicationMatchBatch } from "./matchBatch.js";

type Result = { data?: unknown; error?: unknown };

interface ClientOptions {
  messages?: Result;
  plansByCandidate?: Record<string, Result>;
  updateResult?: { error: unknown };
}

function makeClient(opts: ClientOptions = {}) {
  const updateCalls: Array<{ id: string | undefined; payload: Record<string, unknown> }> = [];
  const planQueries: string[] = [];

  const from = vi.fn((table: string) => {
    const eqArgs: Array<[string, string]> = [];
    let isUpdate = false;
    let payload: Record<string, unknown> = {};

    const builder: Record<string, unknown> = {
      select: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      is: vi.fn(() => builder),
      eq: vi.fn((col: string, val: string) => {
        eqArgs.push([col, val]);
        return builder;
      }),
      update: vi.fn((next: Record<string, unknown>) => {
        isUpdate = true;
        payload = next;
        return builder;
      }),
      then: (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => {
        let result: Result;
        if (table === "messages" && isUpdate) {
          updateCalls.push({ id: eqArgs.find(([c]) => c === "id")?.[1], payload });
          result = opts.updateResult ?? { error: null };
        } else if (table === "messages") {
          result = opts.messages ?? { data: [], error: null };
        } else if (table === "application_plans") {
          const candidateId = eqArgs.find(([c]) => c === "candidate_id")?.[1] ?? "";
          planQueries.push(candidateId);
          result = opts.plansByCandidate?.[candidateId] ?? { data: [], error: null };
        } else {
          result = { data: null, error: new Error(`unexpected table ${table}`) };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };

    return builder;
  });

  return { client: { from } as unknown as SupabaseClient, from, updateCalls, planQueries };
}

function messageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "msg-1",
    sender: "recruiting@acme.com",
    mailbox_connections: { candidate_id: "cand-a" },
    response_classifications: [
      { extracted_company: "Acme Corp", extracted_role: "Senior Backend Engineer", extracted_job_id: "GH-4021" },
    ],
    ...overrides,
  };
}

function planRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "plan-1",
    application_attempts: [{ id: "att-1", created_at: "2026-08-01T00:00:00Z" }],
    vacancies: {
      raw_title: "Senior Backend Engineer",
      source_vacancy_id: "GH-4021",
      companies: { displayed_name: "Acme Corp", domain: "acme.com", career_domain: "careers.acme.com" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runApplicationMatchBatch", () => {
  it("returns all-zero and loads no plans when there are no unlinked classified messages", async () => {
    const { client, from } = makeClient({ messages: { data: [], error: null } });

    const result = await runApplicationMatchBatch(client);

    expect(result).toEqual({ scanned: 0, linked: 0, review: 0, ambiguous: 0, unmatched: 0, errors: 0 });
    expect(from).not.toHaveBeenCalledWith("application_plans");
  });

  it("throws when the messages query errors", async () => {
    const { client } = makeClient({ messages: { data: null, error: new Error("db down") } });
    await expect(runApplicationMatchBatch(client)).rejects.toThrow("db down");
  });

  it("auto-links a message to the matching attempt and records the reasons", async () => {
    const { client, updateCalls } = makeClient({
      messages: { data: [messageRow()], error: null },
      plansByCandidate: { "cand-a": { data: [planRow()], error: null } },
    });

    const result = await runApplicationMatchBatch(client);

    expect(result).toMatchObject({ scanned: 1, linked: 1, review: 0, ambiguous: 0 });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].id).toBe("msg-1");
    expect(updateCalls[0].payload.application_attempt_id).toBe("att-1");
    const match = updateCalls[0].payload.application_match as { confidence: number; reasons: string[]; matched_at: string };
    expect(match.confidence).toBe(1);
    expect(match.reasons).toContain("job_id_exact");
    expect(typeof match.matched_at).toBe("string");
  });

  it("collapses a plan's retry attempts to the newest one as the link target", async () => {
    const { client, updateCalls } = makeClient({
      messages: { data: [messageRow()], error: null },
      plansByCandidate: {
        "cand-a": {
          data: [
            planRow({
              application_attempts: [
                { id: "att-old", created_at: "2026-08-01T00:00:00Z" },
                { id: "att-new", created_at: "2026-08-10T00:00:00Z" },
              ],
            }),
          ],
          error: null,
        },
      },
    });

    await runApplicationMatchBatch(client);

    expect(updateCalls[0].payload.application_attempt_id).toBe("att-new");
  });

  it("counts a mid-band result as review and writes nothing", async () => {
    const { client, updateCalls } = makeClient({
      messages: {
        data: [
          messageRow({
            sender: "recruiting@acme.com",
            response_classifications: [
              { extracted_company: null, extracted_role: "Backend Engineer", extracted_job_id: null },
            ],
          }),
        ],
        error: null,
      },
      plansByCandidate: { "cand-a": { data: [planRow({ vacancies: { raw_title: "Senior Backend Engineer", source_vacancy_id: "GH-4021", companies: { displayed_name: "Acme Corp", domain: "acme.com", career_domain: null } } })], error: null } },
    });

    const result = await runApplicationMatchBatch(client);

    expect(result).toMatchObject({ scanned: 1, linked: 0, review: 1 });
    expect(updateCalls).toHaveLength(0);
  });

  it("counts an ambiguous result and writes nothing", async () => {
    const { client, updateCalls } = makeClient({
      messages: { data: [messageRow()], error: null },
      plansByCandidate: {
        "cand-a": {
          data: [
            planRow({ id: "p1", application_attempts: [{ id: "a1", created_at: "2026-08-01T00:00:00Z" }] }),
            planRow({ id: "p2", application_attempts: [{ id: "a2", created_at: "2026-08-01T00:00:00Z" }] }),
          ],
          error: null,
        },
      },
    });

    const result = await runApplicationMatchBatch(client);

    expect(result).toMatchObject({ scanned: 1, linked: 0, ambiguous: 1 });
    expect(updateCalls).toHaveLength(0);
  });

  it("counts a message as unmatched when the candidate has no applications", async () => {
    const { client } = makeClient({
      messages: { data: [messageRow()], error: null },
      plansByCandidate: { "cand-a": { data: [], error: null } },
    });

    const result = await runApplicationMatchBatch(client);

    expect(result).toMatchObject({ scanned: 1, linked: 0, unmatched: 1 });
  });

  it("loads each candidate's applications only once across their messages", async () => {
    const { client, planQueries } = makeClient({
      messages: {
        data: [messageRow({ id: "m1" }), messageRow({ id: "m2" })],
        error: null,
      },
      plansByCandidate: { "cand-a": { data: [planRow()], error: null } },
    });

    await runApplicationMatchBatch(client);

    expect(planQueries).toEqual(["cand-a"]);
  });

  it("only ever links a message to its own candidate's attempt", async () => {
    const { client, planQueries, updateCalls } = makeClient({
      messages: {
        data: [
          messageRow({ id: "m1", mailbox_connections: { candidate_id: "cand-a" } }),
          messageRow({ id: "m2", mailbox_connections: { candidate_id: "cand-b" } }),
        ],
        error: null,
      },
      plansByCandidate: {
        "cand-a": { data: [planRow()], error: null },
        "cand-b": {
          data: [planRow({ id: "plan-b", application_attempts: [{ id: "att-b", created_at: "2026-08-01T00:00:00Z" }] })],
          error: null,
        },
      },
    });

    const result = await runApplicationMatchBatch(client);

    expect(result).toMatchObject({ scanned: 2, linked: 2 });
    expect(planQueries.sort()).toEqual(["cand-a", "cand-b"]);
    expect(updateCalls.find((c) => c.id === "m1")?.payload.application_attempt_id).toBe("att-1");
    expect(updateCalls.find((c) => c.id === "m2")?.payload.application_attempt_id).toBe("att-b");
  });

  it("counts an update failure as an error, not a link", async () => {
    const { client } = makeClient({
      messages: { data: [messageRow()], error: null },
      plansByCandidate: { "cand-a": { data: [planRow()], error: null } },
      updateResult: { error: { message: "row locked" } },
    });

    const result = await runApplicationMatchBatch(client);

    expect(result).toMatchObject({ scanned: 1, linked: 0, errors: 1 });
  });
});
