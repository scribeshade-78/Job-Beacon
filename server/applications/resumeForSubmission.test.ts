import { describe, expect, it, vi } from "vitest";
import { resolveSubmissionResume } from "./resumeForSubmission.js";

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
};

function makeClient(
  level: string | null,
  extra: Partial<Record<string, TableResult>> = {},
  options: { download?: { data: unknown; error: unknown } } = {},
) {
  const defaults: Record<string, TableResult> = {
    candidate_profiles: { data: { resume_optimization_level: level }, error: null },
    extracted_facts: { data: CONFIRMED_FACTS, error: null },
    fact_confirmations: {
      data: CONFIRMED_FACTS.map((fact) => ({ extracted_fact_id: fact.id, corrected_value: null })),
      error: null,
    },
    vacancies: { data: { raw_title: "Staff Data Engineer" }, error: null },
    vacancy_jd_snapshots: { data: { clean_text: "Spark, Airflow" }, error: null },
    resume_documents: {
      data: {
        id: "doc-base",
        storage_path: "cand-1/base.pdf",
        original_filename: "base.pdf",
        mime_type: "application/pdf",
        optimization_level: null,
      },
      error: null,
    },
    application_attempts: { data: null, error: null },
  };

  const results = { ...defaults, ...extra };
  const updates: Array<{ table: string; payload: unknown }> = [];
  const uploads: Array<{ bucket: string; path: string }> = [];

  const from = vi.fn((table: string) => {
    const result = results[table];
    if (!result) throw new Error(`Unexpected table: ${table}`);

    const builder = makeQueryBuilder(result);
    builder.update = (payload: unknown) => {
      updates.push({ table, payload });
      return builder;
    };
    return builder;
  });

  const downloads: string[] = [];
  const storageFrom = vi.fn((bucket: string) => ({
    upload: async (path: string) => {
      uploads.push({ bucket, path });
      return { data: { path }, error: null };
    },
    download: async (path: string) => {
      downloads.push(path);
      // DEFAULT: no object. The base-text read treats that as "no text recorded" and proceeds
      // silently, which is what every test that does not care about the diff should get - and
      // it is also the honest default, because that is what an older document looks like.
      return options.download ?? { data: null, error: { message: "Object not found" } };
    },
  }));

  // The insert path needs the tailored row's id back.
  const insertBuilder = {
    select: () => ({
      single: async () => ({
        data: {
          id: "doc-tailored",
          storage_path: "cand-1/tailored-x.pdf",
          original_filename: "resume-staff-data-engineer.pdf",
          mime_type: "application/pdf",
        },
        error: null,
      }),
    }),
  };
  const baseDocumentResult = results.resume_documents ?? { data: null, error: null };
  const inserts: Array<Record<string, unknown>> = [];
  const resumeDocumentsProxy = {
    insert: (payload: Record<string, unknown>) => {
      inserts.push(payload);
      return insertBuilder;
    },
    // Only the insert path is exercised for a tailored row, but the base-resume
    // read goes through here too when the level is off.
    select: () => makeQueryBuilder(baseDocumentResult),
  };

  const realFrom = from;
  const fromWithInsert = vi.fn((table: string) =>
    table === "resume_documents" ? (resumeDocumentsProxy as never) : realFrom(table),
  );

  return {
    client: { from: fromWithInsert, storage: { from: storageFrom } } as never,
    updates,
    uploads,
    downloads,
    inserts,
  };
}

function fakeBrowser() {
  const close = vi.fn(async () => {});
  return async () =>
    ({
      newPage: async () => ({
        setContent: async () => {},
        pdf: async () => Buffer.from([37, 80, 68, 70]),
        close: async () => {},
      }),
      close,
    }) as never;
}

function makeModel(response: unknown) {
  const create = vi.fn(async () => ({
    choices: [{ message: { content: typeof response === "string" ? response : JSON.stringify(response) } }],
  }));
  return { factory: () => ({ chat: { completions: { create } } }) as never, create };
}

const input = { applicationAttemptId: "attempt-1", candidateId: "cand-1", vacancyId: "vac-1" };

describe("resolveSubmissionResume — off", () => {
  it("returns the candidate's own uploaded file", async () => {
    const { client } = makeClient("off");

    const resume = await resolveSubmissionResume(
      client,
      { launchBrowser: fakeBrowser() },
      input,
    );

    expect(resume).toEqual({
      documentId: "doc-base",
      storagePath: "cand-1/base.pdf",
      originalFilename: "base.pdf",
      mimeType: "application/pdf",
      tailored: false,
      optimizationLevel: "off",
    });
  });

  it("never constructs an OpenAI client, so an unset API key cannot fail an off submission", async () => {
    const { client } = makeClient("off");
    const createOpenAIClient = vi.fn(() => {
      throw new Error("OPENROUTER_API_KEY is required.");
    });

    await expect(
      resolveSubmissionResume(client, { launchBrowser: fakeBrowser(), createOpenAIClient }, input),
    ).resolves.toMatchObject({ tailored: false });
    expect(createOpenAIClient).not.toHaveBeenCalled();
  });

  it("never launches a browser", async () => {
    const { client } = makeClient("off");
    const launchBrowser = vi.fn(fakeBrowser());

    await resolveSubmissionResume(client, { launchBrowser }, input);

    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("writes nothing to the attempt, because no new document exists to link", async () => {
    const { client, updates, uploads } = makeClient("off");

    await resolveSubmissionResume(client, { launchBrowser: fakeBrowser() }, input);

    expect(uploads).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

describe("resolveSubmissionResume — recording the base text for the review diff", () => {
  const baseBytes = { arrayBuffer: async () => new TextEncoder().encode("Led a team of four engineers").buffer };

  it("records the base text alongside the tailored text when the base file can be read", async () => {
    const { client, inserts, downloads } = makeClient("honest", {}, { download: { data: baseBytes, error: null } });
    const model = makeModel(TAILORED_RESPONSE);

    const resume = await resolveSubmissionResume(
      client,
      {
        launchBrowser: fakeBrowser(),
        createOpenAIClient: model.factory,
        extractText: async () => "Led a team of four engineers",
      },
      input,
    );

    expect(resume.tailored).toBe(true);
    // The base document is what gets downloaded, not the tailored one.
    expect(downloads).toEqual(["cand-1/base.pdf"]);
    expect(inserts[0].base_text).toBe("Led a team of four engineers");
    expect(String(inserts[0].tailored_text)).toContain("Senior Data Engineer");
  });

  it("proceeds with NO recorded text when the base file cannot be downloaded", async () => {
    // BEST-EFFORT BY DESIGN. The tailored resume is generated from confirmed facts and never
    // reads the base document, so a diff that cannot be computed must never block a submission.
    const { client, inserts } = makeClient("honest", {}, { download: { data: null, error: { message: "Object not found" } } });
    const model = makeModel(TAILORED_RESPONSE);

    await expect(
      resolveSubmissionResume(client, { launchBrowser: fakeBrowser(), createOpenAIClient: model.factory }, input),
    ).resolves.toMatchObject({ tailored: true, documentId: "doc-tailored" });

    expect(inserts[0].base_text).toBeNull();
    expect(inserts[0].tailored_text).toBeNull();
  });

  it("proceeds when the extractor throws, and logs it once", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { client, inserts } = makeClient("honest", {}, { download: { data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null } });
      const model = makeModel(TAILORED_RESPONSE);

      await expect(
        resolveSubmissionResume(
          client,
          {
            launchBrowser: fakeBrowser(),
            createOpenAIClient: model.factory,
            extractText: async () => {
              throw new Error("this PDF could not be parsed");
            },
          },
          input,
        ),
      ).resolves.toMatchObject({ tailored: true });

      expect(inserts[0].tailored_text).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("resolveSubmissionResume — an already-prepared document is reused", () => {
  const preparedDocument = {
    id: "doc-prepared",
    storage_path: "cand-1/prepared.pdf",
    original_filename: "resume-staff-data-engineer.pdf",
    mime_type: "application/pdf",
    optimization_level: "aggressive",
  };

  function preparedClient() {
    return makeClient("honest", {
      application_attempts: { data: { resume_document_id: "doc-prepared" }, error: null },
      resume_documents: { data: preparedDocument, error: null },
    });
  }

  it("returns the prepared document without calling the model at all", async () => {
    const { client } = preparedClient();
    const model = makeModel(TAILORED_RESPONSE);

    const resume = await resolveSubmissionResume(
      client,
      { launchBrowser: fakeBrowser(), createOpenAIClient: model.factory },
      input,
    );

    expect(model.create).not.toHaveBeenCalled();
    expect(resume).toEqual({
      documentId: "doc-prepared",
      storagePath: "cand-1/prepared.pdf",
      originalFilename: "resume-staff-data-engineer.pdf",
      mimeType: "application/pdf",
      tailored: true,
      optimizationLevel: "aggressive",
    });
  });

  it("never launches a browser to prepare a document that already exists", async () => {
    const { client } = preparedClient();
    const launchBrowser = vi.fn(fakeBrowser());

    await resolveSubmissionResume(
      client,
      { launchBrowser, createOpenAIClient: makeModel(TAILORED_RESPONSE).factory },
      input,
    );

    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("does not store a second file, so the approved artifact is the one dispatched", async () => {
    const { client, uploads } = preparedClient();

    await resolveSubmissionResume(
      client,
      { launchBrowser: fakeBrowser(), createOpenAIClient: makeModel(TAILORED_RESPONSE).factory },
      input,
    );

    expect(uploads).toHaveLength(0);
  });

  it("reports the level the document was produced at, not the candidate's current preference", async () => {
    // The preference says "honest" (the fixture default); the file was made
    // under "aggressive" and the candidate changed it afterwards. The evidence
    // has to describe the file that is actually going to be sent.
    const { client } = preparedClient();

    const resume = await resolveSubmissionResume(
      client,
      { launchBrowser: fakeBrowser(), createOpenAIClient: makeModel(TAILORED_RESPONSE).factory },
      input,
    );

    expect(resume.optimizationLevel).toBe("aggressive");
  });

  it("prepares a fresh document when the link points at a row that no longer exists", async () => {
    // resume_document_id is ON DELETE SET NULL, so this is the state a
    // candidate deleting a tailored resume leaves behind — except when the
    // delete and the read race, which is exactly this case.
    const { client, uploads } = makeClient("honest", {
      application_attempts: { data: { resume_document_id: "doc-gone" }, error: null },
      resume_documents: { data: null, error: null },
    });
    const model = makeModel(TAILORED_RESPONSE);

    const resume = await resolveSubmissionResume(
      client,
      { launchBrowser: fakeBrowser(), createOpenAIClient: model.factory },
      input,
    );

    expect(model.create).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(1);
    expect(resume).toMatchObject({ documentId: "doc-tailored", tailored: true });
  });
});

describe("resolveSubmissionResume — honest and aggressive", () => {
  it("generates a PDF, stores it and links it to the attempt", async () => {
    const { client, uploads, updates } = makeClient("honest");
    const model = makeModel(TAILORED_RESPONSE);

    const resume = await resolveSubmissionResume(
      client,
      { launchBrowser: fakeBrowser(), createOpenAIClient: model.factory },
      input,
    );

    expect(model.create).toHaveBeenCalledTimes(1);
    expect(uploads).toEqual([{ bucket: "resumes", path: expect.stringContaining("cand-1/") }]);
    expect(resume).toMatchObject({ tailored: true, optimizationLevel: "honest", documentId: "doc-tailored" });

    expect(updates).toEqual([
      {
        table: "application_attempts",
        payload: expect.objectContaining({ resume_document_id: "doc-tailored" }),
      },
    ]);
  });

  it("links the row for aggressive too, and reports the level it used", async () => {
    const { client, updates } = makeClient("aggressive");

    const resume = await resolveSubmissionResume(
      client,
      { launchBrowser: fakeBrowser(), createOpenAIClient: makeModel(TAILORED_RESPONSE).factory },
      input,
    );

    expect(resume.optimizationLevel).toBe("aggressive");
    expect(updates[0].payload).toMatchObject({ resume_document_id: "doc-tailored" });
  });

  it("honours the caller-supplied level instead of re-reading a setting that may have changed", async () => {
    // The profile says "off"; the caller already read "honest" and passes it.
    // Re-reading here would silently produce an untailored submission.
    const { client, uploads } = makeClient("off");

    const resume = await resolveSubmissionResume(
      client,
      { launchBrowser: fakeBrowser(), createOpenAIClient: makeModel(TAILORED_RESPONSE).factory },
      { ...input, level: "honest" },
    );

    expect(resume.tailored).toBe(true);
    expect(uploads).toHaveLength(1);
  });

  it("propagates a model failure rather than quietly sending the untailored resume", async () => {
    const { client, updates } = makeClient("honest");
    const create = vi.fn(async () => {
      throw new Error("openrouter unreachable");
    });

    await expect(
      resolveSubmissionResume(
        client,
        { launchBrowser: fakeBrowser(), createOpenAIClient: () => ({ chat: { completions: { create } } }) as never },
        input,
      ),
    ).rejects.toThrow(/openrouter unreachable/);
    expect(updates).toHaveLength(0);
  });
});
