import { describe, expect, it, vi } from "vitest";
import {
  ApplicationAttemptNotFoundError,
  approveAttempt,
  approveOwnedAttempt,
  AttemptNotAwaitingReviewError,
  AttemptNotOwnedError,
  AttemptNotPreviewedError,
  DEFAULT_REVIEW_BEFORE_SUBMIT,
  generateAttemptPreview,
  initialAttemptStatusFor,
  loadOwnedAttempt,
  readReviewBeforeSubmit,
} from "./attemptReview.js";
import { PREVIEW_URL_TTL_SECONDS } from "./resumeDocument.js";

type TableResult = { data: unknown; error: unknown };

function makeQueryBuilder(result: TableResult) {
  const builder: PromiseLike<TableResult> & Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    single: async () => result,
    maybeSingle: async () => result,
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as PromiseLike<TableResult> & Record<string, unknown>;
  return builder;
}

const CONFIRMED_FACTS = [
  { id: "fact-1", fact_type: "full_name", fact_value: "Sravani Kolapalli" },
  { id: "fact-2", fact_type: "skill", fact_value: "Apache Spark" },
];

const TAILORED_RESPONSE = {
  headline: { text: "Senior Data Engineer", factRefs: ["fact-2"] },
  summary: { text: "Works in Apache Spark.", factRefs: ["fact-2"] },
  bullets: [{ text: "Apache Spark", factRefs: ["fact-2"] }],
  skills: [{ text: "Apache Spark", factRefs: ["fact-2"] }],
  // The preview generates a cover letter alongside the resume, and this one
  // response satisfies both validators so a stubbed model can serve both calls.
  paragraphs: [{ text: "I work in Apache Spark.", factRefs: ["fact-2"] }],
};

interface MakeClientOptions {
  attempt?: TableResult;
  /** What the compare-and-swap update returns. Empty means "somebody else moved it first". */
  releaseRows?: Array<{ id: string }>;
  releaseError?: unknown;
  /** The document the attempt is already linked to, if any. */
  preparedDocumentId?: string | null;
  /** Overrides the plan owner, for the cross-candidate ownership tests. */
  planCandidateId?: string;
  /** The attempt the plan lookup should find; null simulates a dangling plan id. */
  planRow?: TableResult;
}

function makeClient(options: MakeClientOptions = {}) {
  const results: Record<string, TableResult> = {
    application_attempts: options.attempt ?? {
      data: {
        id: "attempt-1",
        status: "pending_review",
        application_plan_id: "plan-1",
        resume_document_id: options.preparedDocumentId ?? null,
      },
      error: null,
    },
    application_plans:
      options.planRow ?? {
        data: { candidate_id: options.planCandidateId ?? "cand-1", vacancy_id: "vac-1" },
        error: null,
      },
    candidate_profiles: { data: { resume_optimization_level: "honest" }, error: null },
    extracted_facts: { data: CONFIRMED_FACTS, error: null },
    fact_confirmations: {
      data: CONFIRMED_FACTS.map((fact) => ({ extracted_fact_id: fact.id, corrected_value: null })),
      error: null,
    },
    vacancies: { data: { raw_title: "Staff Data Engineer" }, error: null },
    vacancy_jd_snapshots: { data: { clean_text: "Spark" }, error: null },
    resume_documents: {
      data: {
        id: "doc-prepared",
        storage_path: "cand-1/prepared.pdf",
        original_filename: "resume-staff-data-engineer.pdf",
        mime_type: "application/pdf",
        optimization_level: "honest",
      },
      error: null,
    },
  };

  const updates: Array<Record<string, unknown>> = [];
  const updatePredicates: Array<Array<[string, unknown]>> = [];

  const from = vi.fn((table: string) => {
    const result = results[table];
    if (!result) throw new Error(`Unexpected table: ${table}`);
    const builder = makeQueryBuilder(result);

    builder.update = (payload: unknown) => {
      const predicates: Array<[string, unknown]> = [];
      updates.push(payload as Record<string, unknown>);
      updatePredicates.push(predicates);
      const chained: Record<string, unknown> = {
        eq: (column: string, value: unknown) => {
          predicates.push([column, value]);
          return chained;
        },
        select: () => ({
          // A CAS that matched nothing returns an empty array, not an error.
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: options.releaseError ? null : (options.releaseRows ?? [{ id: "attempt-1" }]), error: options.releaseError ?? null }).then(resolve),
        }),
      };
      return chained;
    };

    return builder;
  });

  const uploads: string[] = [];
  const signedPaths: Array<{ path: string; ttl: number }> = [];
  const storageFrom = vi.fn(() => ({
    upload: async (path: string) => {
      uploads.push(path);
      return { data: { path }, error: null };
    },
    createSignedUrl: async (path: string, ttl: number) => {
      signedPaths.push({ path, ttl });
      return { data: { signedUrl: `https://storage.test/${path}?token=signed` }, error: null };
    },
  }));

  // resume_documents is both read (reuse) and written (insert) — the insert
  // path's terminal differs from the read path's, so it is dispatched here.
  const insertBuilder = {
    select: () => ({
      single: async () => ({
        data: {
          id: "doc-new",
          storage_path: "cand-1/tailored.pdf",
          original_filename: "resume-staff-data-engineer.pdf",
          mime_type: "application/pdf",
          optimization_level: "honest",
        },
        error: null,
      }),
    }),
  };

  const client = {
    from: vi.fn((table: string) => {
      if (table === "resume_documents") {
        return { ...(from(table) as object), insert: () => insertBuilder };
      }
      return from(table);
    }),
    storage: { from: storageFrom },
  };

  return { client: client as never, updates, updatePredicates, uploads, signedPaths };
}

function fakeBrowser() {
  return async () =>
    ({
      newPage: async () => ({
        setContent: async () => {},
        pdf: async () => Buffer.from([37, 80, 68, 70]),
        close: async () => {},
      }),
      close: async () => {},
    }) as never;
}

function makeModel(response: unknown = TAILORED_RESPONSE) {
  const create = vi.fn(async () => ({
    choices: [{ message: { content: typeof response === "string" ? response : JSON.stringify(response) } }],
  }));
  return { factory: () => ({ chat: { completions: { create } } }) as never, create };
}

const approveInput = { applicationAttemptId: "attempt-1" };

describe("readReviewBeforeSubmit", () => {
  it("returns the stored preference", async () => {
    const client = {
      from: vi.fn(() => makeQueryBuilder({ data: { review_before_submit: false }, error: null })),
    };
    await expect(readReviewBeforeSubmit(client as never, "cand-1")).resolves.toBe(false);
  });

  it("falls back to the safe default when no profile row exists", async () => {
    const client = { from: vi.fn(() => makeQueryBuilder({ data: null, error: null })) };
    await expect(readReviewBeforeSubmit(client as never, "cand-1")).resolves.toBe(DEFAULT_REVIEW_BEFORE_SUBMIT);
  });

  it("falls back to the safe default for a non-boolean value rather than coercing it", async () => {
    const client = {
      from: vi.fn(() => makeQueryBuilder({ data: { review_before_submit: "yes" }, error: null })),
    };
    await expect(readReviewBeforeSubmit(client as never, "cand-1")).resolves.toBe(true);
  });

  it("propagates a database error instead of silently defaulting to no review", async () => {
    const client = { from: vi.fn(() => makeQueryBuilder({ data: null, error: { message: "db down" } })) };
    await expect(readReviewBeforeSubmit(client as never, "cand-1")).rejects.toBeTruthy();
  });

  it("maps the preference onto the initial status", () => {
    expect(initialAttemptStatusFor(true)).toBe("pending_review");
    expect(initialAttemptStatusFor(false)).toBe("pending");
  });
});

describe("approveAttempt", () => {
  it("prepares the resume and releases the attempt to the queue", async () => {
    const { client, updates, uploads } = makeClient();
    const model = makeModel();

    const result = await approveAttempt(
      client,
      { createOpenAIClient: model.factory, launchBrowser: fakeBrowser() },
      approveInput,
    );

    expect(model.create).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(1);
    expect(result).toMatchObject({
      applicationAttemptId: "attempt-1",
      status: "pending",
      resumePrepared: true,
      resume: { documentId: "doc-new", tailored: true, optimizationLevel: "honest" },
    });
  });

  it("flips the status with a compare-and-swap predicate, not a blind update", async () => {
    const { client, updates, updatePredicates } = makeClient();

    await approveAttempt(client, { createOpenAIClient: makeModel().factory, launchBrowser: fakeBrowser() }, approveInput);

    // The releasing update is the last one written.
    const releasePayload = updates[updates.length - 1];
    expect(releasePayload).toMatchObject({ status: "pending" });
    expect(releasePayload.review_approved_at).toEqual(expect.any(String));

    // ...and it is scoped to the held state, so two approvals cannot both win.
    const releasePredicates = updatePredicates[updatePredicates.length - 1];
    expect(releasePredicates).toContainEqual(["id", "attempt-1"]);
    expect(releasePredicates).toContainEqual(["status", "pending_review"]);
  });

  it("reuses an already-prepared document instead of generating a second one", async () => {
    const { client, uploads } = makeClient({ preparedDocumentId: "doc-prepared" });
    const model = makeModel();

    const result = await approveAttempt(
      client,
      { createOpenAIClient: model.factory, launchBrowser: fakeBrowser() },
      approveInput,
    );

    expect(model.create).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
    expect(result).toMatchObject({ resumePrepared: false, resume: { documentId: "doc-prepared" } });
  });

  it("leaves the attempt held when the resume cannot be prepared", async () => {
    const { client, updates } = makeClient();
    const create = vi.fn(async () => {
      throw new Error("openrouter unreachable");
    });

    await expect(
      approveAttempt(
        client,
        { createOpenAIClient: () => ({ chat: { completions: { create } } }) as never, launchBrowser: fakeBrowser() },
        approveInput,
      ),
    ).rejects.toThrow(/openrouter unreachable/);

    // Nothing released it: an application whose file does not exist must not
    // become claimable.
    expect(updates).toHaveLength(0);
  });

  it("refuses an attempt that is not awaiting review, and says what it is instead", async () => {
    const { client, updates } = makeClient({
      attempt: {
        data: { id: "attempt-1", status: "succeeded", application_plan_id: "plan-1", resume_document_id: null },
        error: null,
      },
    });

    const error = await approveAttempt(
      client,
      { createOpenAIClient: makeModel().factory, launchBrowser: fakeBrowser() },
      approveInput,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AttemptNotAwaitingReviewError);
    expect((error as AttemptNotAwaitingReviewError).status).toBe("succeeded");
    expect(updates).toHaveLength(0);
  });

  it("refuses a cancelled attempt too — a withdrawn application is not approvable", async () => {
    const { client } = makeClient({
      attempt: {
        data: { id: "attempt-1", status: "cancelled", application_plan_id: "plan-1", resume_document_id: null },
        error: null,
      },
    });

    await expect(
      approveAttempt(client, { createOpenAIClient: makeModel().factory, launchBrowser: fakeBrowser() }, approveInput),
    ).rejects.toBeInstanceOf(AttemptNotAwaitingReviewError);
  });

  it("throws a not-found error for an id that does not exist", async () => {
    const { client } = makeClient({ attempt: { data: null, error: null } });

    await expect(
      approveAttempt(client, { createOpenAIClient: makeModel().factory, launchBrowser: fakeBrowser() }, approveInput),
    ).rejects.toBeInstanceOf(ApplicationAttemptNotFoundError);
  });

  it("reports a concurrent approval instead of claiming to have released it twice", async () => {
    // The compare-and-swap matched nothing: another approval moved the row out
    // of pending_review while this one was preparing the resume.
    const { client } = makeClient({ releaseRows: [] });

    await expect(
      approveAttempt(client, { createOpenAIClient: makeModel().factory, launchBrowser: fakeBrowser() }, approveInput),
    ).rejects.toBeInstanceOf(AttemptNotAwaitingReviewError);
  });

  it("propagates a database error from the release update", async () => {
    const { client } = makeClient({ releaseError: { message: "db down" } });

    await expect(
      approveAttempt(client, { createOpenAIClient: makeModel().factory, launchBrowser: fakeBrowser() }, approveInput),
    ).rejects.toBeTruthy();
  });
});

describe("loadOwnedAttempt — the authorization boundary", () => {
  it("returns the attempt when the caller owns the underlying plan", async () => {
    const { client } = makeClient();

    await expect(loadOwnedAttempt(client, "cand-1", "attempt-1")).resolves.toEqual({
      attemptId: "attempt-1",
      status: "pending_review",
      planId: "plan-1",
      candidateId: "cand-1",
      vacancyId: "vac-1",
      resumeDocumentId: null,
    });
  });

  it("refuses an attempt belonging to another candidate", async () => {
    // The read runs as service_role, so RLS is not filtering it — this
    // comparison is the whole check, not a second one behind a policy.
    const { client } = makeClient({ planCandidateId: "candidate-b" });

    await expect(loadOwnedAttempt(client, "candidate-a", "attempt-1")).rejects.toBeInstanceOf(AttemptNotOwnedError);
  });

  it("throws not-found for an attempt id that does not exist", async () => {
    const { client } = makeClient({ attempt: { data: null, error: null } });

    await expect(loadOwnedAttempt(client, "cand-1", "missing")).rejects.toBeInstanceOf(
      ApplicationAttemptNotFoundError,
    );
  });

  it("throws not-found when the plan row is gone, rather than treating it as unowned", async () => {
    const { client } = makeClient({ planRow: { data: null, error: null } });

    await expect(loadOwnedAttempt(client, "cand-1", "attempt-1")).rejects.toBeInstanceOf(
      ApplicationAttemptNotFoundError,
    );
  });

  it("propagates a database error from the attempt lookup", async () => {
    const { client } = makeClient({ attempt: { data: null, error: { message: "db down" } } });

    await expect(loadOwnedAttempt(client, "cand-1", "attempt-1")).rejects.toBeTruthy();
  });
});

describe("generateAttemptPreview", () => {
  it("prepares the resume and returns a signed URL for it", async () => {
    const { client, signedPaths, uploads } = makeClient();
    const model = makeModel();

    const preview = await generateAttemptPreview(
      client,
      { createOpenAIClient: model.factory, launchBrowser: fakeBrowser() },
      { candidateId: "cand-1", applicationAttemptId: "attempt-1" },
    );

    // Two calls since Mini-Phase 2: one for the resume, one for the cover
    // letter. They run in parallel, so the order is not pinned.
    expect(model.create).toHaveBeenCalledTimes(2);
    expect(uploads).toHaveLength(1);
    expect(preview.resumePrepared).toBe(true);
    expect(preview.previewUrl).toContain("token=signed");
    expect(preview.previewUrlExpiresInSeconds).toBe(PREVIEW_URL_TTL_SECONDS);
    expect(preview.resume).toMatchObject({ documentId: "doc-new", tailored: true });
  });

  it("generates the cover letter alongside the resume and returns it for review", async () => {
    const { client } = makeClient();
    const model = makeModel();

    const preview = await generateAttemptPreview(
      client,
      { createOpenAIClient: model.factory, launchBrowser: fakeBrowser() },
      { candidateId: "cand-1", applicationAttemptId: "attempt-1" },
    );

    expect(preview.coverLetter.kind).toBe("generated");
    if (preview.coverLetter.kind === "generated") {
      expect(preview.coverLetter.text).toContain("Apache Spark");
      expect(preview.coverLetter.citedFactCount).toBe(1);
      expect(preview.coverLetter.promptVersion).toBeTruthy();
      expect(preview.coverLetter.generatedAt).toEqual(expect.any(String));
    }
  });

  it("stores the letter and its provenance in one write", async () => {
    const { client, updates } = makeClient();
    const model = makeModel();

    await generateAttemptPreview(
      client,
      { createOpenAIClient: model.factory, launchBrowser: fakeBrowser() },
      { candidateId: "cand-1", applicationAttemptId: "attempt-1" },
    );

    const letterWrite = updates.find((update) => "cover_letter_text" in update);

    // The database refuses a letter without its provenance, so the two must
    // travel in the same update — this is that pairing, asserted client-side.
    expect(letterWrite).toMatchObject({
      cover_letter_text: expect.stringContaining("Apache Spark"),
      cover_letter_prompt_version: expect.any(String),
      cover_letter_model_version: expect.any(String),
      cover_letter_generated_at: expect.any(String),
    });
    expect(letterWrite?.cover_letter_metadata).toMatchObject({
      citedFactCount: 1,
      citations: [{ paragraphIndex: 0, factRefs: ["fact-2"] }],
      vacancyId: "vac-1",
    });
  });

  it("still previews the resume when the cover letter fails the honesty gate", async () => {
    // The letter is supplementary. A model that fabricated a claim must not
    // block an application that is otherwise ready to send — but the candidate
    // must be told, so this is a reported outcome rather than a silent absence.
    const { client, updates } = makeClient();
    const model = makeModel({
      headline: { text: "Senior Data Engineer", factRefs: ["fact-2"] },
      summary: { text: "Works in Apache Spark.", factRefs: ["fact-2"] },
      bullets: [{ text: "Apache Spark", factRefs: ["fact-2"] }],
      skills: [{ text: "Apache Spark", factRefs: ["fact-2"] }],
      paragraphs: [{ text: "I once led a team of forty.", factRefs: [] }],
    });

    const preview = await generateAttemptPreview(
      client,
      { createOpenAIClient: model.factory, launchBrowser: fakeBrowser() },
      { candidateId: "cand-1", applicationAttemptId: "attempt-1" },
    );

    expect(preview.resume).toMatchObject({ documentId: "doc-new" });
    expect(preview.coverLetter.kind).toBe("failed");
    if (preview.coverLetter.kind === "failed") {
      expect(preview.coverLetter.reason).toMatch(/no cited confirmed fact/);
    }
    // Nothing was stored, so the row cannot claim a letter it does not have.
    expect(updates.some((update) => "cover_letter_text" in update)).toBe(false);
  });

  it("signs the document it actually prepared, not some other path", async () => {
    const { client, signedPaths } = makeClient();

    await generateAttemptPreview(
      client,
      { createOpenAIClient: makeModel().factory, launchBrowser: fakeBrowser() },
      { candidateId: "cand-1", applicationAttemptId: "attempt-1" },
    );

    expect(signedPaths).toEqual([{ path: "cand-1/tailored.pdf", ttl: PREVIEW_URL_TTL_SECONDS }]);
  });

  it("reuses an already-prepared resume and signs that instead of generating a second one", async () => {
    // Previewing twice must show the same file twice. Regenerating would show
    // the candidate one document and, on approval, submit whichever the second
    // call happened to link.
    const { client, signedPaths, uploads } = makeClient({ preparedDocumentId: "doc-prepared" });
    const model = makeModel();

    const preview = await generateAttemptPreview(
      client,
      { createOpenAIClient: model.factory, launchBrowser: fakeBrowser() },
      { candidateId: "cand-1", applicationAttemptId: "attempt-1" },
    );

    // The RESUME is not regenerated. The cover letter still is — it is not a
    // stored document with a reuse path, and the resume's reuse is what this
    // test is about.
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(0);
    expect(signedPaths).toEqual([{ path: "cand-1/prepared.pdf", ttl: PREVIEW_URL_TTL_SECONDS }]);
    expect(preview.resumePrepared).toBe(false);
    expect(preview.resume.documentId).toBe("doc-prepared");
  });

  it("refuses to preview an attempt that is not held for review", async () => {
    const { client } = makeClient({
      attempt: {
        data: { id: "attempt-1", status: "succeeded", application_plan_id: "plan-1", resume_document_id: null },
        error: null,
      },
    });

    await expect(
      generateAttemptPreview(
        client,
        { createOpenAIClient: makeModel().factory, launchBrowser: fakeBrowser() },
        { candidateId: "cand-1", applicationAttemptId: "attempt-1" },
      ),
    ).rejects.toBeInstanceOf(AttemptNotAwaitingReviewError);
  });

  it("refuses to preview another candidate's attempt, and generates nothing first", async () => {
    const { client, uploads, signedPaths } = makeClient({ planCandidateId: "candidate-b" });
    const model = makeModel();

    await expect(
      generateAttemptPreview(
        client,
        { createOpenAIClient: model.factory, launchBrowser: fakeBrowser() },
        { candidateId: "candidate-a", applicationAttemptId: "attempt-1" },
      ),
    ).rejects.toBeInstanceOf(AttemptNotOwnedError);

    // The ownership check runs before any work: no model call, no stored file,
    // and above all no signed URL minted for a document the caller has no
    // claim to. A signed URL is a bearer capability, so leaking one is the
    // whole risk this ordering avoids.
    expect(model.create).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
    expect(signedPaths).toHaveLength(0);
  });
});

describe("approveOwnedAttempt", () => {
  it("releases a previewed attempt the caller owns", async () => {
    const { client, updates, updatePredicates } = makeClient({ preparedDocumentId: "doc-prepared" });

    const result = await approveOwnedAttempt(client, { candidateId: "cand-1", applicationAttemptId: "attempt-1" });

    expect(result.status).toBe("pending");
    expect(result.reviewApprovedAt).toEqual(expect.any(String));

    expect(updates[updates.length - 1]).toMatchObject({ status: "pending" });
    expect(updatePredicates[updatePredicates.length - 1]).toContainEqual(["status", "pending_review"]);
  });

  it("refuses to approve an attempt with no prepared resume", async () => {
    // Approving here would mean approving something the candidate was never
    // shown, which is the exact promise review_before_submit makes.
    const { client, updates } = makeClient();

    await expect(
      approveOwnedAttempt(client, { candidateId: "cand-1", applicationAttemptId: "attempt-1" }),
    ).rejects.toBeInstanceOf(AttemptNotPreviewedError);
    expect(updates).toHaveLength(0);
  });

  it("refuses another candidate's attempt", async () => {
    const { client, updates } = makeClient({ planCandidateId: "candidate-b", preparedDocumentId: "doc-prepared" });

    await expect(
      approveOwnedAttempt(client, { candidateId: "candidate-a", applicationAttemptId: "attempt-1" }),
    ).rejects.toBeInstanceOf(AttemptNotOwnedError);
    expect(updates).toHaveLength(0);
  });

  it("refuses an attempt that is no longer held, even with a resume attached", async () => {
    const { client } = makeClient({
      attempt: {
        data: { id: "attempt-1", status: "succeeded", application_plan_id: "plan-1", resume_document_id: "doc-1" },
        error: null,
      },
    });

    await expect(
      approveOwnedAttempt(client, { candidateId: "cand-1", applicationAttemptId: "attempt-1" }),
    ).rejects.toBeInstanceOf(AttemptNotAwaitingReviewError);
  });

  it("reports a concurrent approval instead of claiming success twice", async () => {
    const { client } = makeClient({ preparedDocumentId: "doc-prepared", releaseRows: [] });

    await expect(
      approveOwnedAttempt(client, { candidateId: "cand-1", applicationAttemptId: "attempt-1" }),
    ).rejects.toBeInstanceOf(AttemptNotAwaitingReviewError);
  });
});
