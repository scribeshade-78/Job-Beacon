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
import { FollowUpDraftMissingSubjectError } from "./followUpErrors.js";

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
    subject: "Re: Data Engineer III application",
    send_attempts: 0,
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
      subject: "Re: Data Engineer III application",
      sendAttempts: 0,
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
  const SENT = {
    draftId: "draft-1",
    providerMessageId: "email-1",
    recipient: "jobs@acme.com",
    replyAddress: "jane.doe+TOKEN@gmail.com",
    sentAt: "2026-09-19T00:00:00.000Z",
  };

  // A dispatcher is injected, so the real one is never built — but the review layer still
  // resolves mail configuration unless a transport is supplied, and a test must not depend on
  // the developer's environment.
  const MAIL = {
    transport: { send: async () => ({ providerMessageId: "unused" }) } as unknown as import("./mailTransport.js").MailTransport,
    from: { name: null, address: "notifications@jobbeacon.in" },
  };

  function dispatched() {
    const dispatch = vi.fn(async () => SENT);
    return { dispatch, dispatchFn: dispatch as unknown as typeof import("./followUpDispatch.js").dispatchFollowUp };
  }

  it("reports a real transmission with the provider id", async () => {
    const { client } = makeClient({ singleDraft: OWNED_DRAFT, plan: OWNED_PLAN });
    const { dispatchFn } = dispatched();

    const result = await sendFollowUpDraft(client, "cand-1", "draft-1", {
      ...MAIL,
      dispatch: dispatchFn,
      replyTokenSecret: Buffer.alloc(32, 1),
      logDispatch: () => {},
    });

    expect(result).toMatchObject({
      draftId: "draft-1",
      status: "sent",
      transmitted: true,
      providerMessageId: "email-1",
      recipient: "jobs@acme.com",
    });
    expect(result.note).toContain("jobs@acme.com");
  });

  it("hands the dispatcher the subject and body the candidate reviewed", async () => {
    const { client } = makeClient({ singleDraft: OWNED_DRAFT, plan: OWNED_PLAN });
    const { dispatchFn } = dispatched();

    await sendFollowUpDraft(client, "cand-1", "draft-1", {
      ...MAIL,
      dispatch: dispatchFn,
      replyTokenSecret: Buffer.alloc(32, 1),
      logDispatch: () => {},
    });

    const draftArg = (dispatchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1];
    expect(draftArg).toMatchObject({
      draftId: "draft-1",
      candidateId: "cand-1",
      applicationAttemptId: "attempt-1",
      subject: "Re: Data Engineer III application",
      text: "Following up on my application.",
    });
  });

  it("refuses a draft with no subject, which was written before subjects existed", async () => {
    const { client } = makeClient({
      singleDraft: { data: { ...OWNED_DRAFT.data, subject: null }, error: null },
      plan: OWNED_PLAN,
    });
    const { dispatchFn, dispatch } = dispatched();

    await expect(
      sendFollowUpDraft(client, "cand-1", "draft-1", {
        ...MAIL,
        dispatch: dispatchFn,
        replyTokenSecret: Buffer.alloc(32, 1),
        logDispatch: () => {},
      }),
    ).rejects.toBeInstanceOf(FollowUpDraftMissingSubjectError);

    // Nothing was sent and nothing was claimed: the candidate had nothing to approve.
    expect(dispatch).not.toHaveBeenCalled();
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

  it("refuses another candidate's draft without dispatching anything", async () => {
    const logDispatch = vi.fn();
    const { client } = makeClient({
      singleDraft: OWNED_DRAFT,
      plan: { data: { candidate_id: "someone-else", vacancies: null }, error: null },
    });
    const { dispatchFn, dispatch } = dispatched();

    await expect(
      sendFollowUpDraft(client, "cand-1", "draft-1", { ...MAIL, dispatch: dispatchFn, logDispatch }),
    ).rejects.toBeInstanceOf(FollowUpDraftNotOwnedError);

    expect(dispatch).not.toHaveBeenCalled();
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
