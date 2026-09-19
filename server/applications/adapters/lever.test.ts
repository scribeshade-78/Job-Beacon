import { describe, expect, it, vi } from "vitest";
import {
  createLeverAdapter,
  LEVER_EU_API_BASE,
  LEVER_GLOBAL_API_BASE,
  LeverMissingCredentialError,
  LeverMissingRequiredFactError,
  LeverTargetError,
  redactKey,
  resolveLeverTarget,
} from "./lever.js";
import { AtsSubmissionError } from "./errors.js";

/**
 * Endpoint, auth and rate limits here are from the PRD's cited primary source
 * (raw.githubusercontent.com/lever/postings-api/master/README.md, "Apply to a
 * job posting"): POST /v0/postings/SITE/POSTING-ID?key=APIKEY, name and email
 * required, resume multipart-only, 429 must be handled. These tests pin that
 * contract so a later edit cannot quietly drift from it.
 */

const EU_URL = "https://jobs.eu.lever.co/acme/5ac21346-8e0c-4494-8e7a-3eb92ff77902";
const GLOBAL_URL = "https://jobs.lever.co/acme/5ac21346-8e0c-4494-8e7a-3eb92ff77902";

describe("redactKey", () => {
  it("removes the API key from a URL", () => {
    expect(redactKey("https://api.lever.co/v0/postings/acme/job-1?key=supersecret")).toBe(
      "https://api.lever.co/v0/postings/acme/job-1?key=REDACTED",
    );
  });

  it("removes it when it is not the first parameter", () => {
    expect(redactKey("https://api.lever.co/v0/postings/acme/job-1?x=1&key=supersecret&y=2")).toBe(
      "https://api.lever.co/v0/postings/acme/job-1?x=1&key=REDACTED&y=2",
    );
  });

  it("leaves a keyless URL alone", () => {
    const url = "https://api.lever.co/v0/postings/acme/job-1";
    expect(redactKey(url)).toBe(url);
  });
});

describe("resolveLeverTarget", () => {
  it("posts to the EU instance when the vacancy URL is on it", () => {
    const target = resolveLeverTarget(
      { sourceVacancyId: "posting-1", authoritativeUrl: EU_URL, targetKey: null },
      "acme",
    );
    expect(target.apiBase).toBe(LEVER_EU_API_BASE);
  });

  it("posts to the global instance otherwise", () => {
    const target = resolveLeverTarget(
      { sourceVacancyId: "posting-1", authoritativeUrl: GLOBAL_URL, targetKey: null },
      "acme",
    );
    expect(target.apiBase).toBe(LEVER_GLOBAL_API_BASE);
  });

  it("prefers the stored credential's employer key as the site", () => {
    const target = resolveLeverTarget(
      { sourceVacancyId: "posting-1", authoritativeUrl: GLOBAL_URL, targetKey: "from-source-config" },
      "from-credential",
    );
    expect(target.site).toBe("from-credential");
  });

  it("falls back to the source config then the URL for the site", () => {
    expect(
      resolveLeverTarget({ sourceVacancyId: "p", authoritativeUrl: GLOBAL_URL, targetKey: "from-config" }, null).site,
    ).toBe("from-config");
    expect(resolveLeverTarget({ sourceVacancyId: "p", authoritativeUrl: GLOBAL_URL, targetKey: null }, null).site).toBe(
      "acme",
    );
  });

  it("prefers source_vacancy_id for the posting id and falls back to the URL", () => {
    expect(
      resolveLeverTarget({ sourceVacancyId: "from-column", authoritativeUrl: GLOBAL_URL, targetKey: null }, "acme")
        .postingId,
    ).toBe("from-column");
    expect(
      resolveLeverTarget({ sourceVacancyId: null, authoritativeUrl: GLOBAL_URL, targetKey: null }, "acme").postingId,
    ).toBe("5ac21346-8e0c-4494-8e7a-3eb92ff77902");
  });

  it("refuses rather than guessing when there is no posting id", () => {
    expect(() =>
      resolveLeverTarget({ sourceVacancyId: null, authoritativeUrl: "https://jobs.lever.co/acme", targetKey: null }, "acme"),
    ).toThrow(LeverTargetError);
  });
});

interface FakeOptions {
  credential?: { id: string; secret: string } | null;
  facts?: Array<{ type: string; value: string }>;
  resume?: { storagePath: string; mimeType: string; originalFilename: string } | null;
  vacancy?: Record<string, unknown>;
  response?: { ok: boolean; status: number; body?: unknown; retryAfter?: string };
}

function makeClient(options: FakeOptions = {}) {
  const downloadById = vi.fn(async () => new Uint8Array([1, 2, 3]));

  const facts = options.facts ?? [
    { type: "full_name", value: "Jordan Rivera" },
    { type: "email", value: "jordan@example.test" },
    { type: "phone", value: "+91 90000 00000" },
  ];

  function chain(value: { data: unknown; error: unknown }) {
    const node: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "limit", "update"]) {
      node[method] = () => node;
    }
    node.single = async () => value;
    node.maybeSingle = async () => value;
    node.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
    return node;
  }

  const client = {
    from: (table: string) => {
      if (table === "application_plans") {
        return chain({ data: { vacancy_id: "vac-1", candidate_id: "cand-1" }, error: null });
      }
      if (table === "vacancies") {
        return chain({
          data: options.vacancy ?? {
            source_vacancy_id: "posting-1",
            authoritative_url: GLOBAL_URL,
            vacancies_source: { target_key: "acme" },
          },
          error: null,
        });
      }
      if (table === "extracted_facts") {
        return chain({ data: facts.map((fact, index) => ({ id: "fact-" + index, fact_type: fact.type, fact_value: fact.value })), error: null });
      }
      if (table === "fact_confirmations") {
        return chain({ data: facts.map((_, index) => ({ extracted_fact_id: "fact-" + index, corrected_value: null })), error: null });
      }
      return chain({ data: null, error: null });
    },
  } as never;

  return { client, downloadById };
}

function makeFetch(options: FakeOptions = {}) {
  const response = options.response ?? { ok: true, status: 200, body: { candidateId: "lever-cand-1" } };
  return vi.fn(async () => ({
    ok: response.ok,
    status: response.status,
    headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? options.response?.retryAfter ?? null : null) },
    text: async () => (typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? {})),
    json: async () => response.body ?? {},
  })) as unknown as typeof fetch;
}

const RESUME = {
  documentId: "doc-1",
  storagePath: "cand-1/uuid-Jordan_Rivera.pdf",
  originalFilename: "Jordan_Rivera.pdf",
  mimeType: "application/pdf",
  tailored: true,
  optimizationLevel: "honest" as const,
};

const CONTEXT = { applicationAttemptId: "attempt-1", applicationPlanId: "plan-1", resume: RESUME };

function adapter(options: FakeOptions = {}) {
  const { client, downloadById } = makeClient(options);
  const fetchImpl = makeFetch(options);
  return {
    client,
    fetchImpl,
    adapter: createLeverAdapter({
      fetchImpl,
      // The dependency is named downloadResumeById on the adapter; passing it
      // under any other key silently falls through to the real Storage path.
      downloadResumeById: downloadById,
      loadCredential: async () => (options.credential === undefined ? { id: "cred-1", secret: "test-key" } : options.credential),
    }),
  };
}

describe("leverAdapter.submit", () => {
  it("posts multipart to the documented endpoint with the key in the query string", async () => {
    const { adapter: a, client, fetchImpl } = adapter();

    const result = await a.submit(client, CONTEXT);

    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0];
    expect(url).toBe(LEVER_GLOBAL_API_BASE + "/acme/posting-1?key=test-key");
    expect(init.method).toBe("POST");
    // Content-Type must NOT be set by hand: fetch writes the multipart boundary.
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();

    const form = init.body as FormData;
    expect(form.get("name")).toBe("Jordan Rivera");
    expect(form.get("email")).toBe("jordan@example.test");
    expect(form.get("phone")).toBe("+91 90000 00000");
    expect(form.get("resume")).toBeInstanceOf(Blob);

    expect(result.evidenceType).toBe("lever_submission");
  });

  it("NEVER records the API key in evidence", async () => {
    const { adapter: a, client } = adapter();

    const result = await a.submit(client, CONTEXT);
    const serialised = JSON.stringify(result.payload);

    expect(serialised).not.toContain("test-key");
    expect(result.payload.endpoint).toContain("key=REDACTED");
  });

  it("does not send silent, so the employer's own confirmation still reaches the candidate", async () => {
    const { adapter: a, client, fetchImpl } = adapter();

    await a.submit(client, CONTEXT);

    const init = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0][1];
    expect((init.body as FormData).get("silent")).toBeNull();
  });

  it("records the instance it used", async () => {
    const eu = adapter({
      vacancy: { source_vacancy_id: "posting-1", authoritative_url: EU_URL, vacancies_source: { target_key: "acme" } },
    });
    const result = await eu.adapter.submit(eu.client, CONTEXT);
    expect(result.payload.instance).toBe("eu");
  });

  it("refuses to submit when no active employer credential is stored", async () => {
    const { adapter: a, client, fetchImpl } = adapter({ credential: null });

    await expect(a.submit(client, CONTEXT)).rejects.toThrow(LeverMissingCredentialError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when a required fact is missing rather than sending a blank field", async () => {
    const { adapter: a, client, fetchImpl } = adapter({ facts: [{ type: "email", value: "jordan@example.test" }] });

    await expect(a.submit(client, CONTEXT)).rejects.toThrow(LeverMissingRequiredFactError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("omits an absent optional phone number instead of sending an empty value", async () => {
    const { adapter: a, client, fetchImpl } = adapter({
      facts: [
        { type: "full_name", value: "Jordan Rivera" },
        { type: "email", value: "jordan@example.test" },
      ],
    });

    await a.submit(client, CONTEXT);

    const init = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0][1];
    expect((init.body as FormData).get("phone")).toBeNull();
  });
});

describe("leverAdapter rate-limit and validation classification", () => {
  it("treats 429 as retryable and keeps the provider's Retry-After", async () => {
    const { adapter: a, client } = adapter({
      response: { ok: false, status: 429, body: "rate limited", retryAfter: "120" },
    });

    const error = await a.submit(client, CONTEXT).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AtsSubmissionError);
    const atsError = error as AtsSubmissionError;
    // Lever's own documentation: "Application create requests are rate limited.
    // Your team will need to properly handle 429 responses."
    expect(atsError.retryable).toBe(true);
    expect(atsError.status).toBe(429);
    expect(atsError.retryAfterSeconds).toBe(120);
  });

  it("treats a 4xx validation rejection as terminal, not retryable", async () => {
    const { adapter: a, client } = adapter({ response: { ok: false, status: 422, body: "name is required" } });

    const error = await a.submit(client, CONTEXT).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AtsSubmissionError);
    expect((error as AtsSubmissionError).retryable).toBe(false);
    expect((error as AtsSubmissionError).message).toContain("name is required");
  });

  it("treats a 5xx as retryable", async () => {
    const { adapter: a, client } = adapter({ response: { ok: false, status: 503, body: "" } });

    const error = await a.submit(client, CONTEXT).catch((thrown: unknown) => thrown);

    expect((error as AtsSubmissionError).retryable).toBe(true);
    expect((error as AtsSubmissionError).retryAfterSeconds).toBeNull();
  });
});
