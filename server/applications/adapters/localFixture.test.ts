import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createLocalFixtureAdapter,
  loadConfirmedFactValues,
  MISSING_REQUIRED_FACT_REASON,
  MISSING_RESUME_REASON,
  NAVIGATION_REASON,
  RESUME_ATTACH_REASON,
  SELECTOR_NOT_FOUND_REASON,
} from "./localFixture.js";
import { MOCK_FIELD_IDS, MOCK_SUCCESS_MARKER_ID } from "../../mockEmployer.js";

/** Thenable chainable double: every method returns itself, awaiting resolves. */
function chain(result: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "single", "maybeSingle"]) {
    builder[method] = () => builder;
  }
  builder.then = (resolve: (value: unknown) => void) => resolve(result);
  return builder;
}

function makeClient(options: {
  plan?: { data: unknown; error?: unknown };
  vacancy?: { data: unknown; error?: unknown };
  facts?: unknown[];
  confirmations?: unknown[];
}) {
  const from = vi.fn((table: string) => {
    if (table === "application_plans") return chain({ data: options.plan?.data ?? null, error: options.plan?.error ?? null });
    if (table === "vacancies") return chain({ data: options.vacancy?.data ?? null, error: options.vacancy?.error ?? null });
    if (table === "extracted_facts") return chain({ data: options.facts ?? [], error: null });
    if (table === "fact_confirmations") return chain({ data: options.confirmations ?? [], error: null });
    throw new Error("unexpected table " + table);
  });

  return { from } as unknown as SupabaseClient;
}

function fakeBrowser(
  behaviour: { failGoto?: boolean; failFill?: string; failWait?: boolean; failAttach?: boolean } = {},
) {
  const calls: string[] = [];
  const close = vi.fn(async () => {});

  const page = {
    goto: vi.fn(async (url: string) => {
      calls.push("goto:" + url);
      if (behaviour.failGoto) throw new Error("net::ERR_CONNECTION_REFUSED");
    }),
    fill: vi.fn(async (selector: string, value: string) => {
      calls.push("fill:" + selector + "=" + value);
      if (behaviour.failFill === selector) throw new Error("waiting for selector failed");
    }),
    setInputFiles: vi.fn(async (selector: string, payload: { name: string; mimeType: string }) => {
      calls.push("attach:" + selector + "=" + payload.name + ":" + payload.mimeType);
      if (behaviour.failAttach) throw new Error("waiting for selector failed");
    }),
    click: vi.fn(async (selector: string) => {
      calls.push("click:" + selector);
    }),
    waitForSelector: vi.fn(async (selector: string) => {
      calls.push("wait:" + selector);
      if (behaviour.failWait) throw new Error("Timeout 15000ms exceeded");
    }),
  };

  return {
    calls,
    close,
    launch: async () => ({ newPage: async () => page, close }) as never,
  };
}

const plan = { data: { vacancy_id: "vac-1", candidate_id: "cand-1" }, error: null };
const vacancy = { data: { authoritative_url: "http://127.0.0.1:5000/mock-employer/apply?posting=1", raw_title: "[MOCK] Data Engineer" }, error: null };
const facts = [
  { id: "f1", fact_type: "full_name", fact_value: "Extracted Name" },
  { id: "f2", fact_type: "email", fact_value: "extracted@example.com" },
  { id: "f3", fact_type: "phone", fact_value: "+1 555 0000" },
];
const confirmations = [
  { extracted_fact_id: "f1", corrected_value: null },
  { extracted_fact_id: "f2", corrected_value: null },
  { extracted_fact_id: "f3", corrected_value: null },
];

/**
 * The resume resolveSubmissionResume would have produced. Present on every
 * context here because the fixture form has a mandatory file field: an attempt
 * genuinely cannot be submitted without one, so a test omitting it would be
 * testing a call shape that does not occur.
 */
const baseResume = {
  documentId: "doc-1",
  storagePath: "cand-1/base-resume.pdf",
  originalFilename: "base-resume.pdf",
  mimeType: "application/pdf",
  tailored: false,
  optimizationLevel: "off" as const,
};

const context = { applicationAttemptId: "attempt-1", applicationPlanId: "plan-1", resume: baseResume };

const fakeDownload = async () => new Uint8Array([37, 80, 68, 70]); // "%PDF"

describe("localFixtureAdapter capability", () => {
  it("declares itself supported for its own source only", () => {
    const adapter = createLocalFixtureAdapter();
    expect(adapter.sourceCode).toBe("local_fixture");
    expect(adapter.isAutomatedSubmissionSupported).toBe(true);
    expect(
      adapter.validateSupport({
        vacancy: { sourceCode: "local_fixture", trustStatus: "VERIFIED", rawTitle: "[MOCK] Data Engineer" },
        candidateId: "cand-1",
      }),
    ).toEqual({ supported: true });
  });
});

describe("loadConfirmedFactValues", () => {
  it("returns only confirmed facts", async () => {
    const client = makeClient({ facts, confirmations: [{ extracted_fact_id: "f1", corrected_value: null }] });

    const values = await loadConfirmedFactValues(client, "cand-1");

    expect([...values.keys()]).toEqual(["full_name"]);
  });

  it("prefers a candidate's corrected value over the raw extraction", async () => {
    const client = makeClient({
      facts,
      confirmations: [
        { extracted_fact_id: "f1", corrected_value: "Corrected Name" },
        { extracted_fact_id: "f2", corrected_value: null },
        { extracted_fact_id: "f3", corrected_value: null },
      ],
    });

    const values = await loadConfirmedFactValues(client, "cand-1");

    expect(values.get("full_name")).toBe("Corrected Name");
    expect(values.get("email")).toBe("extracted@example.com");
  });
});

describe("localFixtureAdapter.submit", () => {
  it("fills every required field from confirmed facts and reports success", async () => {
    const browser = fakeBrowser();
    const adapter = createLocalFixtureAdapter({ launchBrowser: browser.launch, downloadResume: fakeDownload });

    const result = await adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context);

    expect(browser.calls).toContain("goto:http://127.0.0.1:5000/mock-employer/apply?posting=1");
    expect(browser.calls).toContain(`fill:#${MOCK_FIELD_IDS.fullName}=Extracted Name`);
    expect(browser.calls).toContain(`fill:#${MOCK_FIELD_IDS.email}=extracted@example.com`);
    expect(browser.calls).toContain(`fill:#${MOCK_FIELD_IDS.phone}=+1 555 0000`);
    expect(browser.calls).toContain(`attach:#${MOCK_FIELD_IDS.resume}=base-resume.pdf:application/pdf`);
    expect(browser.calls).toContain(`click:#${MOCK_FIELD_IDS.submit}`);
    expect(browser.calls).toContain(`wait:#${MOCK_SUCCESS_MARKER_ID}`);

    expect(result.evidenceType).toBe("local_fixture_submission");
    expect(result.payload.confirmationMarker).toBe(MOCK_SUCCESS_MARKER_ID);
    expect(browser.close).toHaveBeenCalled();
  });

  it("records which fields were submitted but never their values", async () => {
    const adapter = createLocalFixtureAdapter({ launchBrowser: fakeBrowser().launch, downloadResume: fakeDownload });

    const result = await adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context);

    expect(result.payload.fieldsSubmitted).toEqual([
      { fieldId: MOCK_FIELD_IDS.fullName, factType: "full_name" },
      { fieldId: MOCK_FIELD_IDS.email, factType: "email" },
      { fieldId: MOCK_FIELD_IDS.phone, factType: "phone" },
    ]);

    // Evidence rows must not become a second copy of the candidate's PII.
    const serialised = JSON.stringify(result.payload);
    expect(serialised).not.toContain("Extracted Name");
    expect(serialised).not.toContain("extracted@example.com");
    expect(serialised).not.toContain("+1 555 0000");
  });

  it("fails with a clear reason code when a mandatory fact is not confirmed", async () => {
    const browser = fakeBrowser();
    const adapter = createLocalFixtureAdapter({ launchBrowser: browser.launch, downloadResume: fakeDownload });
    const client = makeClient({ plan, vacancy, facts, confirmations: [{ extracted_fact_id: "f1", corrected_value: null }] });

    await expect(adapter.submit(client, context)).rejects.toThrow(MISSING_REQUIRED_FACT_REASON);
    await expect(adapter.submit(client, context)).rejects.toThrow(/email/);
    // No browser is opened to discover a data problem.
    expect(browser.calls).toHaveLength(0);
  });

  it("fails rather than submitting a blank required field", async () => {
    const adapter = createLocalFixtureAdapter({ launchBrowser: fakeBrowser().launch, downloadResume: fakeDownload });
    const client = makeClient({
      plan,
      vacancy,
      facts: [
        { id: "f1", fact_type: "full_name", fact_value: "Named" },
        { id: "f2", fact_type: "email", fact_value: "   " },
        { id: "f3", fact_type: "phone", fact_value: "+1 555 0000" },
      ],
      confirmations,
    });

    await expect(adapter.submit(client, context)).rejects.toThrow(MISSING_REQUIRED_FACT_REASON);
  });

  it("surfaces a changed selector as its own reason code", async () => {
    const browser = fakeBrowser({ failFill: `#${MOCK_FIELD_IDS.email}` });
    const adapter = createLocalFixtureAdapter({ launchBrowser: browser.launch, downloadResume: fakeDownload });

    await expect(adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context)).rejects.toThrow(
      SELECTOR_NOT_FOUND_REASON,
    );
    expect(browser.close).toHaveBeenCalled();
  });

  it("surfaces an unreachable target as a navigation reason code", async () => {
    const browser = fakeBrowser({ failGoto: true });
    const adapter = createLocalFixtureAdapter({ launchBrowser: browser.launch, downloadResume: fakeDownload });

    await expect(adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context)).rejects.toThrow(
      NAVIGATION_REASON,
    );
    expect(browser.close).toHaveBeenCalled();
  });

  it("fails when the confirmation marker never appears", async () => {
    const browser = fakeBrowser({ failWait: true });
    const adapter = createLocalFixtureAdapter({ launchBrowser: browser.launch, downloadResume: fakeDownload });

    await expect(adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context)).rejects.toThrow(
      SELECTOR_NOT_FOUND_REASON,
    );
    expect(browser.close).toHaveBeenCalled();
  });

  it("closes the browser even when submission fails", async () => {
    const browser = fakeBrowser({ failWait: true });
    const adapter = createLocalFixtureAdapter({ launchBrowser: browser.launch, downloadResume: fakeDownload });

    await adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context).catch(() => undefined);

    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("localFixtureAdapter.submit — the resume it attaches", () => {
  it("attaches the resolved resume's own filename and mime type, not a hardcoded one", async () => {
    const browser = fakeBrowser();
    const adapter = createLocalFixtureAdapter({ launchBrowser: browser.launch, downloadResume: fakeDownload });

    await adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), {
      ...context,
      resume: {
        documentId: "doc-9",
        storagePath: "cand-1/tailored-xyz-resume-data-engineer.pdf",
        originalFilename: "resume-data-engineer.pdf",
        mimeType: "application/pdf",
        tailored: true,
        optimizationLevel: "aggressive",
      },
    });

    expect(browser.calls).toContain(`attach:#${MOCK_FIELD_IDS.resume}=resume-data-engineer.pdf:application/pdf`);
  });

  it("records which document went out and under which setting", async () => {
    const adapter = createLocalFixtureAdapter({
      launchBrowser: fakeBrowser().launch,
      downloadResume: fakeDownload,
    });

    const result = await adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), {
      ...context,
      resume: {
        documentId: "doc-9",
        storagePath: "cand-1/tailored-xyz-resume-data-engineer.pdf",
        originalFilename: "resume-data-engineer.pdf",
        mimeType: "application/pdf",
        tailored: true,
        optimizationLevel: "honest",
      },
    });

    expect(result.payload.resumeFilename).toBe("resume-data-engineer.pdf");
    expect(result.payload.resumeTailored).toBe(true);
    expect(result.payload.resumeOptimizationLevel).toBe("honest");
  });

  it("records an untailored submission as untailored, so off is visible in the evidence", async () => {
    const adapter = createLocalFixtureAdapter({
      launchBrowser: fakeBrowser().launch,
      downloadResume: fakeDownload,
    });

    const result = await adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context);

    expect(result.payload.resumeTailored).toBe(false);
    expect(result.payload.resumeOptimizationLevel).toBe("off");
  });

  it("refuses to submit at all when no resume was resolved", async () => {
    const browser = fakeBrowser();
    const adapter = createLocalFixtureAdapter({ launchBrowser: browser.launch, downloadResume: fakeDownload });

    await expect(
      adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), {
        applicationAttemptId: "attempt-1",
        applicationPlanId: "plan-1",
      }),
    ).rejects.toThrow(MISSING_RESUME_REASON);
    // No browser is opened to discover a missing attachment.
    expect(browser.calls).toHaveLength(0);
  });

  it("fails before opening a browser when the document cannot be downloaded", async () => {
    const browser = fakeBrowser();
    const adapter = createLocalFixtureAdapter({
      launchBrowser: browser.launch,
      downloadResume: async () => {
        throw new Error(`${RESUME_ATTACH_REASON}: could not download cand-1/base-resume.pdf`);
      },
    });

    await expect(adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context)).rejects.toThrow(
      RESUME_ATTACH_REASON,
    );
    expect(browser.calls).toHaveLength(0);
  });

  it("refuses to attach a document that downloaded as zero bytes", async () => {
    const browser = fakeBrowser();
    const adapter = createLocalFixtureAdapter({
      launchBrowser: browser.launch,
      downloadResume: async () => new Uint8Array(0),
    });

    await expect(adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context)).rejects.toThrow(
      RESUME_ATTACH_REASON,
    );
    expect(browser.calls).toHaveLength(0);
  });

  it("surfaces an unattachable file as its own reason code", async () => {
    const browser = fakeBrowser({ failAttach: true });
    const adapter = createLocalFixtureAdapter({ launchBrowser: browser.launch, downloadResume: fakeDownload });

    await expect(adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context)).rejects.toThrow(
      RESUME_ATTACH_REASON,
    );
    expect(browser.close).toHaveBeenCalled();
  });
});
