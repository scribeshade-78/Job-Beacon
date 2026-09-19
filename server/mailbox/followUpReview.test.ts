import { describe, expect, it, vi } from "vitest";
import {
  dismissFollowUpDraft,
  FollowUpDraftNotFoundError,
  FollowUpDraftNotOwnedError,
  FollowUpDraftNotPendingError,
  listPendingFollowUps,
  loadOwnedDraft,
  sendFollowUpDraft,
} from "./followUpReview.js";

type TableResult = { data: unknown; error: unknown };

/**
 * A double that distinguishes the two reads of a draft (the list, and the
 * single-row load) and records the writes, because most of these tests are
 * about what was written and to which row.
 */
function makeClient(options: {
  drafts?: unknown[];
  singleDraft?: TableResult | null;
  plan?: TableResult;
  updateRows?: unknown[] | null;
} = {}) {
  const updates: Array<{ payload: Record<string, unknown>; predicates: Array<[string, unknown]> }> = [];

  const from = vi.fn((table: string) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = chain;
    b.eq = chain;
    b.order = chain;
    b.limit = chain;

    if (table === "follow_up_drafts") {
      b.maybeSingle = async () => options.singleDraft ?? { data: null, error: null };
      b.update = (payload: Record<string, unknown>) => {
        const predicates: Array<[string, unknown]> = [];
        updates.push({ payload, predicates });
        return {
          eq: (column: string, value: unknown) => {
            predicates.push([column, value]);
            return {
              eq: (c2: string, v2: unknown) => {
                predicates.push([c2, v2]);
                return { select: async () => ({ data: options.updateRows === undefined ? [{ id: "draft-1" }] : options.updateRows, error: null }) };
              },
            };
          },
        };
      };
      b.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: options.drafts ?? [], error: null }).then(resolve);
      return b;
    }

    if (table === "application_plans") {
      b.maybeSingle = async () => options.plan ?? { data: null, error: null };
      return b;
    }

    throw new Error(`Unexpected table: ${table}`);
  });

  return { client: { from } as never, updates };
}

const DRAFT_ROW = {
  id: "draft-1",
  application_attempt_id: "attempt-1",
  draft_text: "Following up on my application.",
  generated_at: "2026-09-18T22:00:00.000Z",
  model_version: "test/model",
  prompt_version: "follow-up-v1",
  application_attempts: {
    succeeded_at: "2026-08-30T00:00:00.000Z",
    application_plans: {
      candidate_id: "cand-1",
      vacancies: {
        raw_title: "Data Engineer III",
        authoritative_url: "https://acme.test/jobs/3",
        companies: { displayed_name: "Acme" },
      },
    },
  },
};

const OWNED_DRAFT = {
  data: {
    id: "draft-1",
    status: "pending_review",
    application_attempt_id: "attempt-1",
    draft_text: "Following up on my application.",
    application_attempts: { application_plan_id: "plan-1" },
  },
  error: null,
};

const OWNED_PLAN = {
  data: { candidate_id: "cand-1", vacancies: { raw_title: "Data Engineer III", companies: { displayed_name: "Acme" } } },
  error: null,
};

/** Fixed clock so the day arithmetic is deterministic. */
const NOW = Date.parse("2026-09-19T00:00:00.000Z");

describe("listPendingFollowUps", () => {
  it("returns the fields the review UI shows", async () => {
    const { client } = makeClient({ drafts: [DRAFT_ROW] });

    const pending = await listPendingFollowUps(client, "cand-1", { now: NOW });

    expect(pending).toEqual([
      {
        draftId: "draft-1",
        applicationAttemptId: "attempt-1",
        companyName: "Acme",
        vacancyTitle: "Data Engineer III",
        vacancyUrl: "https://acme.test/jobs/3",
        daysSinceSubmission: 20,
        submittedAt: "2026-08-30T00:00:00.000Z",
        draftText: "Following up on my application.",
        generatedAt: "2026-09-18T22:00:00.000Z",
        modelVersion: "test/model",
        promptVersion: "follow-up-v1",
      },
    ]);
  });

  it("counts days from the submission, computed now rather than stored", async () => {
    // A draft can sit in the queue, and the stored age from detection time
    // would show a stale number on exactly the applications that waited longest.
    const { client } = makeClient({ drafts: [DRAFT_ROW] });

    const atSubmission = await listPendingFollowUps(client, "cand-1", { now: Date.parse("2026-08-31T00:00:00.000Z") });
    const later = await listPendingFollowUps(client, "cand-1", { now: Date.parse("2026-09-10T00:00:00.000Z") });

    expect(atSubmission[0]?.daysSinceSubmission).toBe(1);
    expect(later[0]?.daysSinceSubmission).toBe(11);
  });

  it("excludes another candidate's draft", async () => {
    // The service-role client bypasses the RLS policy that could scope this, so
    // the comparison IS the boundary.
    const other = {
      ...DRAFT_ROW,
      id: "draft-other",
      application_attempts: {
        ...DRAFT_ROW.application_attempts,
        application_plans: { ...DRAFT_ROW.application_attempts.application_plans, candidate_id: "someone-else" },
      },
    };
    const { client } = makeClient({ drafts: [other] });

    await expect(listPendingFollowUps(client, "cand-1", { now: NOW })).resolves.toEqual([]);
  });

  it("survives a vacancy with no company and no authoritative url", async () => {
    const bare = {
      ...DRAFT_ROW,
      application_attempts: {
        ...DRAFT_ROW.application_attempts,
        application_plans: {
          candidate_id: "cand-1",
          vacancies: { raw_title: "[MOCK] Role", authoritative_url: "", companies: null },
        },
      },
    };
    const { client } = makeClient({ drafts: [bare] });

    const pending = await listPendingFollowUps(client, "cand-1", { now: NOW });

    expect(pending[0]?.companyName).toBeNull();
    expect(pending[0]?.vacancyTitle).toBe("[MOCK] Role");
  });

  it("reports zero days rather than a negative number for a future timestamp", async () => {
    const future = { ...DRAFT_ROW, application_attempts: { ...DRAFT_ROW.application_attempts, succeeded_at: "2027-01-01T00:00:00.000Z" } };
    const { client } = makeClient({ drafts: [future] });

    const pending = await listPendingFollowUps(client, "cand-1", { now: NOW });

    expect(pending[0]?.daysSinceSubmission).toBe(0);
  });

  it("puts the longest-waiting application first", async () => {
    const older = {
      ...DRAFT_ROW,
      id: "draft-older",
      application_attempts: { ...DRAFT_ROW.application_attempts, succeeded_at: "2026-07-01T00:00:00.000Z" },
    };
    const { client } = makeClient({ drafts: [DRAFT_ROW, older] });

    const pending = await listPendingFollowUps(client, "cand-1", { now: NOW });

    expect(pending.map((p) => p.draftId)).toEqual(["draft-older", "draft-1"]);
  });
});

describe("loadOwnedDraft", () => {
  it("returns the draft with its vacancy and company", async () => {
    const { client } = makeClient({ singleDraft: OWNED_DRAFT, plan: OWNED_PLAN });

    await expect(loadOwnedDraft(client, "cand-1", "draft-1")).resolves.toEqual({
      draftId: "draft-1",
      status: "pending_review",
      applicationAttemptId: "attempt-1",
      vacancyTitle: "Data Engineer III",
      companyName: "Acme",
      draftText: "Following up on my application.",
    });
  });

  it("throws not-found for an id that does not exist", async () => {
    const { client } = makeClient({ singleDraft: { data: null, error: null } });

    await expect(loadOwnedDraft(client, "cand-1", "missing")).rejects.toBeInstanceOf(FollowUpDraftNotFoundError);
  });

  it("refuses another candidate's draft", async () => {
    const { client } = makeClient({
      singleDraft: OWNED_DRAFT,
      plan: { data: { candidate_id: "someone-else", vacancies: null }, error: null },
    });

    await expect(loadOwnedDraft(client, "cand-1", "draft-1")).rejects.toBeInstanceOf(FollowUpDraftNotOwnedError);
  });
});

describe("sendFollowUpDraft", () => {
  it("marks the draft sent", async () => {
    const { client, updates } = makeClient({ singleDraft: OWNED_DRAFT, plan: OWNED_PLAN });

    const result = await sendFollowUpDraft(client, "cand-1", "draft-1", { logDispatch: () => {} });

    expect(result).toMatchObject({ draftId: "draft-1", status: "sent" });
    expect(updates[0]?.payload).toMatchObject({ status: "sent" });
  });

  it("says plainly that nothing was transmitted", async () => {
    // A caller rendering "Sent" from a 200 would be making a claim this endpoint
    // cannot support, so the fact travels in the result rather than being
    // inferred from the absence of an error.
    const { client } = makeClient({ singleDraft: OWNED_DRAFT, plan: OWNED_PLAN });

    const result = await sendFollowUpDraft(client, "cand-1", "draft-1", { logDispatch: () => {} });

    expect(result.transmitted).toBe(false);
    expect(result.note).toContain("No email was transmitted");
  });

  it("logs the draft body, which is the entire dispatch", async () => {
    const logDispatch = vi.fn();
    const { client } = makeClient({ singleDraft: OWNED_DRAFT, plan: OWNED_PLAN });

    await sendFollowUpDraft(client, "cand-1", "draft-1", { logDispatch });

    expect(logDispatch).toHaveBeenCalledTimes(1);
    const detail = logDispatch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(detail.body).toBe("Following up on my application.");
    expect(detail.company).toBe("Acme");
    // Honest about the gap: there is no recipient address in this schema.
    expect(detail.to).toBeNull();
  });

  it("uses a compare-and-swap predicate, so a concurrent approval cannot double-fire", async () => {
    const { client, updates } = makeClient({ singleDraft: OWNED_DRAFT, plan: OWNED_PLAN });

    await sendFollowUpDraft(client, "cand-1", "draft-1", { logDispatch: () => {} });

    expect(updates[0]?.predicates).toContainEqual(["id", "draft-1"]);
    expect(updates[0]?.predicates).toContainEqual(["status", "pending_review"]);
  });

  it("refuses a draft that is not awaiting review", async () => {
    const { client } = makeClient({
      singleDraft: { data: { ...OWNED_DRAFT.data, status: "sent" }, error: null },
      plan: OWNED_PLAN,
    });

    await expect(sendFollowUpDraft(client, "cand-1", "draft-1")).rejects.toBeInstanceOf(
      FollowUpDraftNotPendingError,
    );
  });

  it("reports a concurrent change rather than claiming to have sent it", async () => {
    const { client } = makeClient({ singleDraft: OWNED_DRAFT, plan: OWNED_PLAN, updateRows: [] });

    await expect(sendFollowUpDraft(client, "cand-1", "draft-1")).rejects.toBeInstanceOf(
      FollowUpDraftNotPendingError,
    );
  });

  it("refuses another candidate's draft without logging anything", async () => {
    const logDispatch = vi.fn();
    const { client } = makeClient({
      singleDraft: OWNED_DRAFT,
      plan: { data: { candidate_id: "someone-else", vacancies: null }, error: null },
    });

    await expect(sendFollowUpDraft(client, "cand-1", "draft-1", { logDispatch })).rejects.toBeInstanceOf(
      FollowUpDraftNotOwnedError,
    );
    // Nothing is logged for a draft the caller does not own: the log line
    // contains the body, so emitting it would leak a stranger's letter.
    expect(logDispatch).not.toHaveBeenCalled();
  });
});

describe("dismissFollowUpDraft", () => {
  it("marks the draft dismissed", async () => {
    const { client, updates } = makeClient({ singleDraft: OWNED_DRAFT, plan: OWNED_PLAN });

    const result = await dismissFollowUpDraft(client, "cand-1", "draft-1");

    expect(result).toEqual({ draftId: "draft-1", status: "dismissed" });
    expect(updates[0]?.payload).toMatchObject({ status: "dismissed" });
  });

  it("does not log or send anything", async () => {
    const logDispatch = vi.fn();
    const { client } = makeClient({ singleDraft: OWNED_DRAFT, plan: OWNED_PLAN });

    await dismissFollowUpDraft(client, "cand-1", "draft-1");

    expect(logDispatch).not.toHaveBeenCalled();
  });

  it("refuses a draft that is not awaiting review", async () => {
    const { client } = makeClient({
      singleDraft: { data: { ...OWNED_DRAFT.data, status: "sent" }, error: null },
      plan: OWNED_PLAN,
    });

    await expect(dismissFollowUpDraft(client, "cand-1", "draft-1")).rejects.toBeInstanceOf(
      FollowUpDraftNotPendingError,
    );
  });

  it("refuses another candidate's draft", async () => {
    const { client } = makeClient({
      singleDraft: OWNED_DRAFT,
      plan: { data: { candidate_id: "someone-else", vacancies: null }, error: null },
    });

    await expect(dismissFollowUpDraft(client, "cand-1", "draft-1")).rejects.toBeInstanceOf(FollowUpDraftNotOwnedError);
  });
});
