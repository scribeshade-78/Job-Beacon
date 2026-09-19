import { describe, expect, it, vi } from "vitest";
import { findGhostedAttempts, runFollowUpSweep, type GhostedAttempt } from "./antiGhosting.js";
import { MalformedFollowUpError } from "./followUpGenerator.js";
import { UncitedClaimError } from "../applications/resumeGenerator.js";

/**
 * The DETECTION RULE is SQL and is asserted directly against the database in
 * supabase/tests/database/anti_ghosting.test.sql — ten assertions covering the
 * 7-day window, real replies, acknowledgements, unclassified mail and existing
 * drafts. What is under test here is this module's own behaviour: how it reads
 * the detector's rows, and what it does with each outcome.
 */

function makeClient(options: { insertError?: { message: string } | null } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];

  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    rpcCalls.push(args);
    return { data: [], error: null };
  });

  const from = vi.fn(() => {
    const builder: Record<string, unknown> = {
      insert: (payload: Record<string, unknown>) => {
        inserts.push(payload);
        return builder;
      },
      select: () => builder,
      single: async () =>
        options.insertError
          ? { data: null, error: options.insertError }
          : { data: { id: "draft-1" }, error: null },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return builder;
  });

  return { client: { rpc, from } as never, inserts, rpcCalls };
}

const ATTEMPT: GhostedAttempt = {
  applicationAttemptId: "attempt-1",
  candidateId: "cand-1",
  vacancyId: "vac-1",
  submittedAt: "2026-08-29T10:00:00.000Z",
  daysSinceSubmission: 20,
};

const DRAFT = {
  paragraphs: [{ text: "Following up.", factRefs: ["application:vacancy_title"] }],
  text: "Following up.",
  modelVersion: "test/model",
  promptVersion: "follow-up-v1",
  citedFactCount: 1,
  metadata: {
    promptVersion: "follow-up-v1",
    modelVersion: "test/model",
    generatedAt: "2026-09-18T22:00:00.000Z",
    citedFactCount: 1,
    citations: [{ paragraphIndex: 0, factRefs: ["application:vacancy_title"] }],
    applicationFacts: {
      vacancyTitle: "Data Engineer III",
      companyName: "Acme",
      submittedAt: "2026-08-29T10:00:00.000Z",
      daysSinceSubmission: 20,
    },
  },
};

describe("findGhostedAttempts", () => {
  it("calls the detector with the default window and no guessing about age", async () => {
    const { client, rpcCalls } = makeClient();

    await findGhostedAttempts(client);

    // The 7-day rule lives in SQL. This module must not re-apply it or invent
    // its own, or there would be two definitions of "ghosted".
    expect(rpcCalls).toEqual([{ p_min_age_days: 7, p_limit: 20 }]);
  });

  it("passes a caller's window through rather than clamping it", async () => {
    const { client, rpcCalls } = makeClient();

    await findGhostedAttempts(client, { minAgeDays: 30, limit: 5 });

    expect(rpcCalls).toEqual([{ p_min_age_days: 30, p_limit: 5 }]);
  });

  it("maps the detector's rows onto this module's shape", async () => {
    const rpc = vi.fn(async () => ({
      data: [
        {
          application_attempt_id: "attempt-1",
          candidate_id: "cand-1",
          vacancy_id: "vac-1",
          submitted_at: "2026-08-29T10:00:00.000Z",
          days_since_submission: 20,
        },
      ],
      error: null,
    }));

    const attempts = await findGhostedAttempts({ rpc } as never);

    expect(attempts).toEqual([ATTEMPT]);
  });

  it("propagates a detector failure instead of reporting no ghosted applications", async () => {
    // The distinction that matters: "nothing is ghosted" and "the query broke"
    // must not look the same, or a broken detector silently becomes a feature
    // that never fires.
    const rpc = vi.fn(async () => ({ data: null, error: { message: "db down" } }));

    await expect(findGhostedAttempts({ rpc } as never)).rejects.toBeTruthy();
  });
});

describe("runFollowUpSweep", () => {
  it("drafts one follow-up per detected application", async () => {
    const { client, inserts } = makeClient();
    const generate = vi.fn(async () => DRAFT);

    const result = await runFollowUpSweep(
      client,
      { openai: {} as never, findGhosted: async () => [ATTEMPT], generate: generate as never },
    );

    expect(result).toMatchObject({ detected: 1, drafted: 1, failed: 0 });
    expect(generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ candidateId: "cand-1", vacancyId: "vac-1", daysSinceSubmission: 20 }),
    );
  });

  it("stores the draft with its provenance and in pending_review", async () => {
    const { client, inserts } = makeClient();

    await runFollowUpSweep(client, {
      openai: {} as never,
      findGhosted: async () => [ATTEMPT],
      generate: (async () => DRAFT) as never,
    });

    // model_version and prompt_version are NOT NULL on the table, so a draft
    // that could not say how it was made would be rejected by the database.
    // This asserts the writer actually supplies them.
    expect(inserts[0]).toMatchObject({
      application_attempt_id: "attempt-1",
      draft_text: "Following up.",
      status: "pending_review",
      model_version: "test/model",
      prompt_version: "follow-up-v1",
      generated_at: "2026-09-18T22:00:00.000Z",
    });
    expect(inserts[0]?.metadata).toMatchObject({ citedFactCount: 1 });
  });

  it("keeps going when one application's generation fails", async () => {
    const second: GhostedAttempt = { ...ATTEMPT, applicationAttemptId: "attempt-2", vacancyId: "vac-2" };
    const { client } = makeClient();
    let call = 0;
    const generate = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new UncitedClaimError(["An invented sentence."]);
      return DRAFT;
    });

    const result = await runFollowUpSweep(client, {
      openai: {} as never,
      findGhosted: async () => [ATTEMPT, second],
      generate: generate as never,
    });

    expect(result).toMatchObject({ detected: 2, drafted: 1, failed: 1 });
    expect(result.outcomes[0]).toMatchObject({ applicationAttemptId: "attempt-1", outcome: "failed" });
    expect(result.outcomes[1]).toMatchObject({ applicationAttemptId: "attempt-2", outcome: "drafted" });
  });

  it("writes NOTHING for a draft the gate refused, so a later sweep retries it", async () => {
    // A placeholder row would both hide the failure and permanently exclude the
    // attempt through the detector's "already drafted" rule.
    const { client, inserts } = makeClient();

    const result = await runFollowUpSweep(client, {
      openai: {} as never,
      findGhosted: async () => [ATTEMPT],
      generate: (async () => {
        throw new UncitedClaimError(["An invented sentence."]);
      }) as never,
    });

    expect(inserts).toHaveLength(0);
    expect(result.failed).toBe(1);
  });

  it("reports the gate's own reason rather than a generic failure", async () => {
    const { client } = makeClient();

    const result = await runFollowUpSweep(client, {
      openai: {} as never,
      findGhosted: async () => [ATTEMPT],
      generate: (async () => {
        throw new UncitedClaimError(["An invented sentence."]);
      }) as never,
    });

    // The whole value of refusing rather than sending is knowing what was
    // refused. "generation failed" would leave an operator with a number.
    expect(result.outcomes[0]?.error).toContain("UncitedClaimError");
    expect(result.outcomes[0]?.error).toContain("An invented sentence.");
  });

  it("names a malformed response as such", async () => {
    const { client } = makeClient();

    const result = await runFollowUpSweep(client, {
      openai: {} as never,
      findGhosted: async () => [ATTEMPT],
      generate: (async () => {
        throw new MalformedFollowUpError("response was not valid JSON");
      }) as never,
    });

    expect(result.outcomes[0]?.error).toContain("MalformedFollowUpError");
  });

  it("treats a duplicate draft as skipped, not as a failure", async () => {
    // A concurrent sweep drafting the same attempt hits the unique constraint.
    // The draft exists, which is the goal — reporting a failure would be wrong.
    const { client } = makeClient({ insertError: { message: "duplicate key value violates unique constraint" } });

    const result = await runFollowUpSweep(client, {
      openai: {} as never,
      findGhosted: async () => [ATTEMPT],
      generate: (async () => DRAFT) as never,
    });

    expect(result).toMatchObject({ drafted: 0, failed: 0 });
    expect(result.outcomes[0]).toMatchObject({ outcome: "skipped" });
    expect(result.outcomes[0]?.skippedBecause).toContain("duplicate key");
  });

  it("does nothing at all when nothing was detected", async () => {
    const { client, inserts } = makeClient();
    const generate = vi.fn();

    const result = await runFollowUpSweep(client, {
      openai: {} as never,
      findGhosted: async () => [],
      generate: generate as never,
    });

    expect(result).toMatchObject({ detected: 0, drafted: 0, failed: 0 });
    expect(inserts).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it("propagates a detection failure rather than reporting an empty sweep", async () => {
    const { client } = makeClient();

    await expect(
      runFollowUpSweep(client, {
        openai: {} as never,
        findGhosted: async () => {
          throw new Error("detector down");
        },
        generate: (async () => DRAFT) as never,
      }),
    ).rejects.toThrow(/detector down/);
  });

  it("never writes to the attempt or sends anything", async () => {
    // Phase scope: detection, drafting and storage. No status change, no
    // mailbox write, no application_attempts update.
    const { client } = makeClient();

    await runFollowUpSweep(client, {
      openai: {} as never,
      findGhosted: async () => [ATTEMPT],
      generate: (async () => DRAFT) as never,
    });

    const tables = (client as unknown as { from: { mock: { calls: unknown[][] } } }).from.mock.calls.map((c) => c[0]);
    expect(new Set(tables)).toEqual(new Set(["follow_up_drafts"]));
  });
});
