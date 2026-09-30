import { beforeEach, describe, expect, it, vi } from "vitest";
import { ingestEmailResponse, parseRawEmailPayload, UnparseableEmailError } from "./emailParser.js";

/**
 * The classifier and the matcher are mocked so no model call happens; the real
 * ones have their own suites (mailbox/classifyMessage.test.ts,
 * mailbox/matchApplication.test.ts). What is under test here is that an email
 * payload travels the pipeline and lands on the right application.
 */
vi.mock("../mailbox/classifyBatch.js", () => ({
  classifyAndStoreMessage: vi.fn(async () => ({ kind: "classified", category: "rejection" })),
}));

vi.mock("../mailbox/matchBatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mailbox/matchBatch.js")>();
  return { ...actual, loadCandidateApplications: vi.fn(), matchOneClassifiedMessage: vi.fn() };
});

import { classifyAndStoreMessage } from "../mailbox/classifyBatch.js";
import { loadCandidateApplications, matchOneClassifiedMessage } from "../mailbox/matchBatch.js";

const mockedClassify = vi.mocked(classifyAndStoreMessage);
const mockedLoad = vi.mocked(loadCandidateApplications);
const mockedMatch = vi.mocked(matchOneClassifiedMessage);

interface ClassificationRow {
  category: string;
  confidence: number | null;
  extracted_company: string | null;
  extracted_role: string | null;
  extracted_job_id: string | null;
  extracted_deadline: string | null;
  extracted_salary_text: string | null;
}

const REJECTION_ROW: ClassificationRow = {
  category: "rejection",
  confidence: 0.93,
  extracted_company: "Lemon.io",
  extracted_role: "Senior Data Engineer",
  extracted_job_id: null,
  extracted_deadline: null,
  extracted_salary_text: null,
};

const INTERVIEW_ROW: ClassificationRow = {
  ...REJECTION_ROW,
  category: "interview",
  confidence: 0.9,
  extracted_deadline: "2026-09-22",
};

interface ClientOptions {
  /** What the classifier produced, read back by the post-classification SELECT. */
  classification?: ClassificationRow;
  /** True when a classification row already existed, so the model call is skipped. */
  alreadyClassified?: boolean;
  messageAlreadyLinked?: string | null;
}

/**
 * A stateful-enough double that distinguishes the two reads of
 * response_classifications — "does one already exist?" (maybeSingle) from "read
 * the stored one back" (single) — and drives the derived stage from the
 * classification actually ingested, rather than from a hardcoded fixture. The
 * old version returned one canned answer for both, which meant the
 * skip-the-model guard always fired and every stage assertion read 'rejection'
 * regardless of the email.
 */
function makeClient(options: ClientOptions = {}) {
  const classification = options.classification ?? REJECTION_ROW;
  const writes: Array<{ table: string; payload: Record<string, unknown> }> = [];

  const attemptsRow = {
    id: "attempt-1",
    status: "succeeded",
    application_plan_id: "plan-1",
    // The embedded parent row readStageForAttempt asks for alongside the
    // attempts; eligible=true keeps the derived stage about the response.
    application_plans: { gate_results: { eligible: true } },
    messages: [{ id: "msg-1", response_classifications: [{ category: classification.category }] }],
  };

  const from = vi.fn((table: string) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = chain;
    b.eq = chain;
    b.is = chain;
    b.order = chain;
    b.limit = chain;
    b.upsert = (payload: Record<string, unknown>) => {
      writes.push({ table, payload });
      return b;
    };
    b.update = (payload: Record<string, unknown>) => {
      writes.push({ table, payload });
      return b;
    };

    if (table === "mailbox_connections") {
      b.maybeSingle = async () => ({ data: { id: "conn-1" }, error: null });
      return b;
    }

    if (table === "messages") {
      b.single = async () => ({
        data: { id: "msg-1", application_attempt_id: options.messageAlreadyLinked ?? null },
        error: null,
      });
      return b;
    }

    if (table === "response_classifications") {
      b.maybeSingle = async () => ({ data: options.alreadyClassified ? { id: "class-existing" } : null, error: null });
      b.single = async () => ({ data: classification, error: null });
      return b;
    }

    if (table === "application_attempts") {
      // First read: the linked attempt. Second read: every attempt on the plan,
      // with the message that was just linked.
      b.maybeSingle = async () => ({ data: { id: "attempt-1", status: "succeeded", application_plan_id: "plan-1" }, error: null });
      b.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [attemptsRow], error: null }).then(resolve);
      return b;
    }

    throw new Error(`Unexpected table: ${table}`);
  });

  return { client: { from } as never, writes };
}

const rejectionEmail = {
  from: "Lemon.io Recruiting <jobs@lemon.io>",
  subject: "Update on your application for Senior Data Engineer",
  body: "Thank you for your interest. After careful consideration we will not be moving forward with your application.",
  date: "2026-09-17T09:00:00.000Z",
};

const interviewEmail = [
  'From: "Talent" <talent@lemon.io>',
  "Subject: Interview invitation — Senior Data Engineer",
  "Date: 2026-09-17T10:00:00.000Z",
  "",
  "We would like to invite you to a 45 minute interview. Please confirm availability.",
].join("\n");

beforeEach(() => {
  mockedClassify.mockClear();
  mockedLoad.mockReset();
  mockedMatch.mockReset();
  mockedLoad.mockResolvedValue([]);
});

describe("parseRawEmailPayload", () => {
  it("reads a JSON object and accepts the common field aliases", () => {
    const parsed = parseRawEmailPayload(rejectionEmail);

    expect(parsed.sender).toBe("Lemon.io Recruiting <jobs@lemon.io>");
    expect(parsed.subject).toContain("Senior Data Engineer");
    expect(parsed.bodyText).toContain("will not be moving forward");
    expect(parsed.receivedAt).toBe("2026-09-17T09:00:00.000Z");
  });

  it("reads a raw RFC822-ish text email", () => {
    const parsed = parseRawEmailPayload(interviewEmail);

    expect(parsed.sender).toContain("talent@lemon.io");
    expect(parsed.subject).toBe("Interview invitation — Senior Data Engineer");
    expect(parsed.bodyText).toContain("45 minute interview");
    expect(parsed.bodyText).not.toContain("Subject:");
  });

  it("treats headerless text as the whole body", () => {
    const parsed = parseRawEmailPayload("We regret to inform you that the position has been filled.");

    expect(parsed.bodyText).toContain("position has been filled");
    expect(parsed.subject).toBeNull();
  });

  it("derives a stable id from content when the payload carries none", () => {
    const first = parseRawEmailPayload(rejectionEmail);
    const second = parseRawEmailPayload(rejectionEmail);

    expect(first.idDerived).toBe(true);
    // Content-addressed, so re-ingesting the same payload collides on the
    // unique index instead of duplicating the email.
    expect(first.providerMessageId).toBe(second.providerMessageId);
    // ...and a different payload does not collide with it.
    expect(parseRawEmailPayload(interviewEmail).providerMessageId).not.toBe(first.providerMessageId);
  });

  it("prefers a supplied provider message id over a derived one", () => {
    const parsed = parseRawEmailPayload({ ...rejectionEmail, providerMessageId: "gmail-abc123" });

    expect(parsed.providerMessageId).toBe("gmail-abc123");
    expect(parsed.idDerived).toBe(false);
  });

  it("refuses a payload with neither subject nor body rather than spending a model call on nothing", () => {
    expect(() => parseRawEmailPayload({ from: "a@b.com" })).toThrow(UnparseableEmailError);
    expect(() => parseRawEmailPayload("   ")).toThrow(UnparseableEmailError);
    expect(() => parseRawEmailPayload(42)).toThrow(UnparseableEmailError);
  });

  it("unfolds a continued header line", () => {
    const parsed = parseRawEmailPayload("From: a@b.com\nSubject: A very long subject\n that continues here\n\nBody.");

    expect(parsed.subject).toBe("A very long subject that continues here");
  });
});

describe("ingestEmailResponse — a rejection email", () => {
  it("stores the message, classifies it, and links it to the matching application", async () => {
    const { client, writes } = makeClient();
    mockedMatch.mockResolvedValue({
      kind: "auto",
      attemptId: "attempt-1",
      confidence: 1,
      reasons: ["company_name_exact"],
      linked: true,
    });

    const result = await ingestEmailResponse(client, {} as never, { candidateId: "cand-1", raw: rejectionEmail });

    expect(result.classification.category).toBe("rejection");
    expect(result.match).toMatchObject({ kind: "auto", attemptId: "attempt-1" });

    // The message row is written before classification, so a model failure
    // leaves a recoverable email rather than losing it.
    const messageWrite = writes.find((w) => w.table === "messages");
    expect(messageWrite?.payload).toMatchObject({ sender: rejectionEmail.from, subject: rejectionEmail.subject });
  });

  it("reports the application's stage AFTER the link, from the derivation the UI uses", async () => {
    const { client } = makeClient();
    mockedMatch.mockResolvedValue({
      kind: "auto",
      attemptId: "attempt-1",
      confidence: 1,
      reasons: ["company_name_exact"],
      linked: true,
    });

    const result = await ingestEmailResponse(client, {} as never, { candidateId: "cand-1", raw: rejectionEmail });

    // A linked rejection classification derives the Rejection stage — NOT
    // application_attempts.status, which stays 'succeeded' and means something
    // else entirely.
    expect(result.stageAfter).toBe("rejection");
  });

  it("hands the classifier the parsed body, not the raw payload", async () => {
    const { client } = makeClient();
    mockedMatch.mockResolvedValue({ kind: "none" });

    await ingestEmailResponse(client, {} as never, { candidateId: "cand-1", raw: interviewEmail });

    expect(mockedClassify).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        messageId: "msg-1",
        subject: "Interview invitation — Senior Data Engineer",
        bodyText: expect.stringContaining("45 minute interview"),
      }),
      undefined,
    );
  });

  it("hands the extracted entities to the matcher", async () => {
    const { client } = makeClient();
    mockedMatch.mockResolvedValue({ kind: "none" });

    await ingestEmailResponse(client, {} as never, { candidateId: "cand-1", raw: rejectionEmail });

    expect(mockedMatch).toHaveBeenCalledWith(
      expect.anything(),
      { id: "msg-1", sender: rejectionEmail.from },
      { extracted_company: "Lemon.io", extracted_role: "Senior Data Engineer", extracted_job_id: null },
      expect.anything(),
    );
  });
});

describe("ingestEmailResponse — an interview invitation", () => {
  it("reports the interview stage for a linked interview classification", async () => {
    const { client } = makeClient({ classification: INTERVIEW_ROW });
    mockedMatch.mockResolvedValue({
      kind: "auto",
      attemptId: "attempt-1",
      confidence: 1,
      reasons: ["role_title_exact"],
      linked: true,
    });

    const result = await ingestEmailResponse(client, {} as never, { candidateId: "cand-1", raw: interviewEmail });

    expect(result.classification.category).toBe("interview");
    expect(result.classification.deadline).toBe("2026-09-22");
    expect(result.stageAfter).toBe("interview");
  });

  it("does not invent an outcome when the interview classification is unlinked", async () => {
    const { client } = makeClient({ classification: INTERVIEW_ROW });
    mockedMatch.mockResolvedValue({ kind: "review", candidates: [] });

    const result = await ingestEmailResponse(client, {} as never, { candidateId: "cand-1", raw: interviewEmail });

    expect(result.match.kind).toBe("review");
    expect(result.stageAfter).toBeNull();
  });
});

describe("ingestEmailResponse — the paths that must not lie", () => {
  it("does not link when the match is not confident, and still classifies the email", async () => {
    const { client } = makeClient();
    mockedMatch.mockResolvedValue({ kind: "review", candidates: [] });

    const result = await ingestEmailResponse(client, {} as never, { candidateId: "cand-1", raw: rejectionEmail });

    expect(result.match.attemptId).toBeNull();
    // No link means no stage to report — and reporting one anyway would claim
    // an application moved when nothing was linked to it.
    expect(result.stageAfter).toBeNull();
    expect(result.classification.category).toBe("rejection");
  });

  it("reports a confident no-match honestly", async () => {
    const { client } = makeClient();
    mockedMatch.mockResolvedValue({ kind: "none" });

    const result = await ingestEmailResponse(client, {} as never, { candidateId: "cand-1", raw: rejectionEmail });

    expect(result.match.kind).toBe("none");
    expect(result.stageAfter).toBeNull();
  });

  it("skips the model call when the message already carries a classification", async () => {
    const { client } = makeClient({ alreadyClassified: true });
    mockedMatch.mockResolvedValue({ kind: "none" });

    await ingestEmailResponse(client, {} as never, { candidateId: "cand-1", raw: rejectionEmail });

    expect(mockedClassify).not.toHaveBeenCalled();
  });

  it("classifies when no existing classification is found", async () => {
    const { client } = makeClient({ alreadyClassified: false });
    mockedMatch.mockResolvedValue({ kind: "none" });

    await ingestEmailResponse(client, {} as never, { candidateId: "cand-1", raw: rejectionEmail });

    expect(mockedClassify).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing link instead of matching again", async () => {
    const { client } = makeClient({ messageAlreadyLinked: "attempt-existing" });

    const result = await ingestEmailResponse(client, {} as never, { candidateId: "cand-1", raw: rejectionEmail });

    expect(result.match).toMatchObject({ attemptId: "attempt-existing" });
    expect(mockedMatch).not.toHaveBeenCalled();
    // The stage is still read back for the existing link, so a re-ingest
    // reports where the application actually stands.
    expect(result.stageAfter).toBe("rejection");
  });

  it("never writes a status to the attempt or the plan", async () => {
    const { client, writes } = makeClient();
    mockedMatch.mockResolvedValue({
      kind: "auto",
      attemptId: "attempt-1",
      confidence: 1,
      reasons: ["company_name_exact"],
      linked: true,
    });

    await ingestEmailResponse(client, {} as never, { candidateId: "cand-1", raw: rejectionEmail });

    // The candidate-visible outcome is derived from the link. Persisting it
    // into application_attempts.status would be a second answer to the same
    // question — and 'rejected' is not a status that column can hold without
    // breaking what 'failed' already means.
    expect(writes.map((w) => w.table)).not.toContain("application_attempts");
    expect(writes.map((w) => w.table)).not.toContain("application_plans");
  });
});
