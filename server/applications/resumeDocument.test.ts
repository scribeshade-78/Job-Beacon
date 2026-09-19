import { describe, expect, it, vi } from "vitest";
import {
  escapeHtml,
  renderTailoredResumeHtml,
  renderPdfFromHtml,
  resumeFilenameFor,
  storeTailoredResume,
  TailoredResumeRenderError,
  TailoredResumeStorageError,
} from "./resumeDocument.js";
import type { ResumeFactEntry, TailoredResumeContent } from "./resumeGenerator.js";

const facts: ResumeFactEntry[] = [
  { extractedFactId: "f1", factType: "full_name", factValue: "Sravani Kolapalli", relevant: false },
  { extractedFactId: "f2", factType: "email", factValue: "s@example.com", relevant: false },
  { extractedFactId: "f3", factType: "phone", factValue: "+1 555 0100", relevant: false },
  { extractedFactId: "f4", factType: "location", factValue: "Hyderabad", relevant: false },
  { extractedFactId: "f5", factType: "skill", factValue: "Apache Spark", relevant: true },
];

const content: TailoredResumeContent = {
  headline: { text: "Senior Data Engineer", factRefs: ["f1"] },
  summary: { text: "Data engineer working in Apache Spark.", factRefs: ["f2", "f5"] },
  bullets: [
    { text: "Builds pipelines in Apache Spark", factRefs: ["f5"] },
    { text: "Based in Hyderabad", factRefs: ["f4"] },
  ],
  skills: [{ text: "Apache Spark", factRefs: ["f5"] }],
};

describe("escapeHtml", () => {
  it("escapes the characters that would otherwise change the document's structure", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;",
    );
  });

  it("escapes ampersands before the entities it introduces, so nothing is double-decoded", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("resumeFilenameFor", () => {
  it("builds a readable filename from the vacancy title", () => {
    expect(resumeFilenameFor("[MOCK] Data Engineer — Local Fixture")).toBe("resume-mock-data-engineer-local-fixture.pdf");
  });

  it("never produces a path separator or a leading dot", () => {
    expect(resumeFilenameFor("../../etc/passwd")).toBe("resume-etc-passwd.pdf");
  });

  it("falls back to a fixed name when the title has nothing usable", () => {
    expect(resumeFilenameFor("—")).toBe("resume-tailored.pdf");
    expect(resumeFilenameFor("")).toBe("resume-tailored.pdf");
  });

  it("truncates without leaving a trailing hyphen", () => {
    const name = resumeFilenameFor("Senior Staff Principal Data Platform Engineer Architect");
    expect(name.endsWith("-.pdf")).toBe(false);
    expect(name.length).toBeLessThanOrEqual("resume-".length + 40 + ".pdf".length);
  });
});

describe("renderTailoredResumeHtml", () => {
  const html = renderTailoredResumeHtml({ content, facts, vacancyTitle: "[MOCK] Data Engineer" });

  it("puts the candidate's confirmed contact details in the header", () => {
    expect(html).toContain("Sravani Kolapalli");
    expect(html).toContain("s@example.com");
    expect(html).toContain("+1 555 0100");
  });

  it("renders every tailored section", () => {
    expect(html).toContain("Senior Data Engineer");
    expect(html).toContain("Data engineer working in Apache Spark.");
    expect(html).toContain("Builds pipelines in Apache Spark");
    expect(html).toContain("Skills");
  });

  it("omits a section the model left empty rather than rendering a blank heading", () => {
    const empty = renderTailoredResumeHtml({
      content: { ...content, summary: { text: "", factRefs: [] }, skills: [] },
      facts,
      vacancyTitle: "x",
    });

    expect(empty).not.toContain("<h2>Summary</h2>");
    expect(empty).not.toContain("<h2>Skills</h2>");
    expect(empty).toContain("<h2>Experience</h2>");
  });

  it("escapes fact values, so a name containing markup cannot break the document", () => {
    // The header is the one place a raw fact string reaches the page, so this
    // is where an unescaped value would actually do damage.
    const hostile = renderTailoredResumeHtml({
      content,
      facts: facts.map((fact) =>
        fact.factType === "full_name" ? { ...fact, factValue: "<b>Eng</b> & <i>Co</i>" } : fact,
      ),
      vacancyTitle: "x",
    });

    expect(hostile).not.toContain("<b>Eng</b>");
    expect(hostile).toContain("&lt;b&gt;Eng&lt;/b&gt; &amp; &lt;i&gt;Co&lt;/i&gt;");
  });

  it("escapes the model's own output too, not just the facts", () => {
    const hostile = renderTailoredResumeHtml({
      content: { ...content, headline: { text: "<img src=x onerror=alert(1)>", factRefs: ["f1"] } },
      facts,
      vacancyTitle: "x",
    });

    expect(hostile).not.toContain("<img src=x");
    expect(hostile).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("references no external resource, so the render never needs the network", () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<img");
  });

  it("does not put the vacancy title in the document body", () => {
    // The title is used for the filename and the prompt, not printed as though
    // the candidate had written it.
    expect(html).not.toContain("[MOCK] Data Engineer");
  });
});

function fakePdfBrowser(behaviour: { failSetContent?: boolean; pdfBytes?: number[] } = {}) {
  const close = vi.fn(async () => {});
  const pageClose = vi.fn(async () => {});
  const setContent = vi.fn(async () => {
    if (behaviour.failSetContent) throw new Error("renderer crashed");
  });
  const pdf = vi.fn(async () => Buffer.from(behaviour.pdfBytes ?? [37, 80, 68, 70]));

  const page = { setContent, pdf, close: pageClose };

  return {
    page,
    close,
    pageClose,
    setContent,
    launch: async () => ({ newPage: async () => page, close }) as never,
  };
}

describe("renderPdfFromHtml", () => {
  it("returns the rendered bytes", async () => {
    const browser = fakePdfBrowser();
    const bytes = await renderPdfFromHtml("<html></html>", { launchBrowser: browser.launch });

    expect([...bytes]).toEqual([37, 80, 68, 70]);
    expect(browser.setContent).toHaveBeenCalledWith("<html></html>", { waitUntil: "load" });
  });

  it("refuses an empty document rather than storing a zero-byte file", async () => {
    const browser = fakePdfBrowser({ pdfBytes: [] });

    await expect(renderPdfFromHtml("<html></html>", { launchBrowser: browser.launch })).rejects.toBeInstanceOf(
      TailoredResumeRenderError,
    );
  });

  it("closes the page and the browser when rendering throws", async () => {
    const browser = fakePdfBrowser({ failSetContent: true });

    await expect(renderPdfFromHtml("<html></html>", { launchBrowser: browser.launch })).rejects.toBeTruthy();
    expect(browser.pageClose).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

type TableResult = { data: unknown; error: unknown };

function makeClient(options: {
  uploadError?: { message: string } | null;
  insertResult?: TableResult;
}) {
  const upload = vi.fn(async () => ({ data: { path: "p" }, error: options.uploadError ?? null }));
  const single = vi.fn(async () =>
    options.insertResult ?? {
      data: {
        id: "doc-1",
        storage_path: "p",
        original_filename: "n.pdf",
        mime_type: "application/pdf",
        optimization_level: "honest",
      },
      error: null,
    },
  );
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ insert }));
  const storageFrom = vi.fn(() => ({ upload }));

  return {
    client: { from, storage: { from: storageFrom } } as never,
    upload,
    insert,
    storageFrom,
    from,
  };
}

describe("storeTailoredResume", () => {
  /**
   * The level is part of the input, not a default, because it is written onto
   * the row: the document has to be able to say which setting produced it.
   */
  const storeInput = {
    candidateId: "cand-1",
    vacancyId: "vac-1",
    vacancyTitle: "[MOCK] Data Engineer",
    content,
    facts,
    optimizationLevel: "honest" as const,
  };

  it("uploads a PDF to the candidate's own folder under the resumes bucket", async () => {
    const { client, upload, storageFrom } = makeClient({});

    await storeTailoredResume(client, { launchBrowser: fakePdfBrowser().launch }, {
      ...storeInput,
    });

    expect(storageFrom).toHaveBeenCalledWith("resumes");
    const [path, , options] = upload.mock.calls[0] as unknown as [string, Uint8Array, { contentType: string }];
    expect(path.startsWith("cand-1/")).toBe(true);
    expect(path.endsWith("resume-mock-data-engineer.pdf")).toBe(true);
    expect(options.contentType).toBe("application/pdf");
  });

  it("gives each generation its own path, so regenerating never overwrites a file an earlier application referenced", async () => {
    const { client, upload } = makeClient({});
    const deps = { launchBrowser: fakePdfBrowser().launch };
    const input = { ...storeInput };

    await storeTailoredResume(client, deps, input);
    await storeTailoredResume(client, deps, input);

    const first = (upload.mock.calls[0] as unknown as [string])[0];
    const second = (upload.mock.calls[1] as unknown as [string])[0];
    expect(first).not.toBe(second);
  });

  it("records the row as kind='tailored', which is what keeps it off the Resumes page", async () => {
    const { client, insert } = makeClient({});

    await storeTailoredResume(client, { launchBrowser: fakePdfBrowser().launch }, {
      ...storeInput,
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ candidate_id: "cand-1", kind: "tailored", mime_type: "application/pdf", byte_size: 4 }),
    );
  });

  it("returns the stored row so the caller can link it to the attempt", async () => {
    const { client } = makeClient({});

    const document = await storeTailoredResume(client, { launchBrowser: fakePdfBrowser().launch }, {
      ...storeInput,
    });

    expect(document).toEqual({
      documentId: "doc-1",
      storagePath: "p",
      originalFilename: "n.pdf",
      mimeType: "application/pdf",
      optimizationLevel: "honest",
    });
  });

  it("fails with the upload's own reason when Storage rejects it", async () => {
    const { client, insert } = makeClient({ uploadError: { message: "bucket policy denied" } });

    await expect(
      storeTailoredResume(client, { launchBrowser: fakePdfBrowser().launch }, {
        ...storeInput,
        vacancyTitle: "x",
      }),
    ).rejects.toThrow(/bucket policy denied/);
    // Nothing is recorded, so there is no row pointing at a file that is not there.
    expect(insert).not.toHaveBeenCalled();
  });

  it("says so when the file uploaded but recording it failed", async () => {
    const { client } = makeClient({ insertResult: { data: null, error: { message: "permission denied" } } });

    await expect(
      storeTailoredResume(client, { launchBrowser: fakePdfBrowser().launch }, {
        ...storeInput,
        vacancyTitle: "x",
      }),
    ).rejects.toBeInstanceOf(TailoredResumeStorageError);
  });
});
