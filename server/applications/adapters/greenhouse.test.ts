import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createGreenhouseAdapter,
  GREENHOUSE_BOARD_API_BASE,
  GreenhouseCredentialsError,
  GreenhouseTargetError,
  MISSING_CREDENTIALS_REASON,
  MISSING_REQUIRED_FACT_REASON,
  MISSING_RESUME_REASON,
  readGreenhouseCredentials,
  resolveGreenhouseTarget,
  splitFullName,
  SUBMISSION_REJECTED_REASON,
  UNPARSEABLE_TARGET_REASON,
} from "./greenhouse.js";

/** Thenable chainable double. Write methods throw, pinning the read-only shape of the lookups. */
function chain(result: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit", "maybeSingle", "single"]) {
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
    if (table === "application_plans") return chain(options.plan ?? { data: null, error: null });
    if (table === "vacancies") return chain(options.vacancy ?? { data: null, error: null });
    if (table === "extracted_facts") return chain({ data: options.facts ?? [], error: null });
    if (table === "fact_confirmations") return chain({ data: options.confirmations ?? [], error: null });
    throw new Error("unexpected table " + table);
  });

  return { from } as unknown as SupabaseClient;
}

function formToObject(body: unknown): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const [key, value] of (body as FormData).entries()) {
    entries[key] = value;
  }
  return entries;
}

const plan = { data: { vacancy_id: "vac-1", candidate_id: "cand-1" } };
const vacancy = {
  data: {
    source_vacancy_id: "127817",
    authoritative_url: "https://boards.greenhouse.io/very_awesome_inc/jobs/127817",
    vacancies_source: { target_key: "very_awesome_inc" },
  },
};
const facts = [
  { id: "f1", fact_type: "full_name", fact_value: "Mary Jane Watson" },
  { id: "f2", fact_type: "email", fact_value: "mary@example.com" },
  { id: "f3", fact_type: "phone", fact_value: "+1 555 0100" },
];
const confirmations = facts.map((fact) => ({ extracted_fact_id: fact.id, corrected_value: null }));

const resume = { bytes: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf", filename: "cv.pdf" };

function makeAdapter(overrides: {
  response?: { ok?: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> };
  credentials?: { apiKey: string } | (() => never);
} = {}) {
  const response = {
    ok: overrides.response?.ok ?? true,
    status: overrides.response?.status ?? 200,
    json: overrides.response?.json ?? (async () => ({ id: 987654 })),
    text: overrides.response?.text ?? (async () => ""),
  };

  const fetchImpl = vi.fn(async () => response as unknown as Response);
  const downloadResume = vi.fn(async () => resume);

  // Captured before the branch: reading overrides.credentials inside the arrow
  // would widen it back to the union and lose the narrowing.
  const credentialsOption = overrides.credentials;
  const readCredentials =
    typeof credentialsOption === "function"
      ? credentialsOption
      : () => credentialsOption ?? { apiKey: "test-key" };

  const adapter = createGreenhouseAdapter({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    readCredentials,
    // Task H3: the adapter now resolves the employer's key from the encrypted
    // credential store first, keyed by board token. These tests predate the
    // store and inject a key directly, so the store lookup is stubbed to "no row
    // for this board" — which is exactly the condition under which the adapter
    // falls back to readCredentials. Without this the fake client would be asked
    // for an ats_credentials table it does not implement.
    loadCredential: async () => null,
    downloadResume,
  });

  return { adapter, fetchImpl, downloadResume };
}

const context = { applicationAttemptId: "attempt-1", applicationPlanId: "plan-1" };

describe("splitFullName", () => {
  it("splits on the last space so multi-word given names stay intact", () => {
    expect(splitFullName("Mary Jane Watson")).toEqual({ firstName: "Mary Jane", lastName: "Watson" });
  });

  it("handles a simple two-token name and collapses whitespace", () => {
    expect(splitFullName("  Sammy   McSamson ")).toEqual({ firstName: "Sammy", lastName: "McSamson" });
  });

  it("refuses a single-token name rather than inventing a last name", () => {
    expect(() => splitFullName("Madonna")).toThrow(MISSING_REQUIRED_FACT_REASON);
  });
});

describe("resolveGreenhouseTarget", () => {
  it("prefers the authoritative columns", () => {
    expect(
      resolveGreenhouseTarget({
        sourceVacancyId: "127817",
        authoritativeUrl: "https://example.test/whatever",
        targetKey: "very_awesome_inc",
      }),
    ).toEqual({ boardToken: "very_awesome_inc", jobId: "127817" });
  });

  it("falls back to parsing the URL for a vacancy that did not come through discovery", () => {
    expect(
      resolveGreenhouseTarget({
        sourceVacancyId: null,
        authoritativeUrl: "https://job-boards.greenhouse.io/acme/jobs/55555",
        targetKey: null,
      }),
    ).toEqual({ boardToken: "acme", jobId: "55555" });
  });

  it("fails clearly when neither source yields a board token", () => {
    expect(() =>
      resolveGreenhouseTarget({ sourceVacancyId: "1", authoritativeUrl: "https://example.test/x", targetKey: null }),
    ).toThrow(UNPARSEABLE_TARGET_REASON);
  });

  it("fails clearly when neither source yields a job id", () => {
    expect(() =>
      resolveGreenhouseTarget({ sourceVacancyId: null, authoritativeUrl: "https://boards.greenhouse.io/acme", targetKey: "acme" }),
    ).toThrow(GreenhouseTargetError);
  });
});

describe("readGreenhouseCredentials", () => {
  it("returns the configured key", () => {
    expect(readGreenhouseCredentials({ GREENHOUSE_API_KEY: " k " } as NodeJS.ProcessEnv)).toEqual({ apiKey: "k" });
  });

  it("fails with a specific reason code when unset", () => {
    expect(() => readGreenhouseCredentials({} as NodeJS.ProcessEnv)).toThrow(GreenhouseCredentialsError);
    expect(() => readGreenhouseCredentials({} as NodeJS.ProcessEnv)).toThrow(MISSING_CREDENTIALS_REASON);
  });
});

describe("greenhouseAdapter.submit — success", () => {
  it("POSTs multipart form data to the documented endpoint with correct fields", async () => {
    const { adapter, fetchImpl } = makeAdapter();
    const client = makeClient({ plan, vacancy, facts, confirmations });

    const result = await adapter.submit(client, context);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toBe(`${GREENHOUSE_BOARD_API_BASE}/very_awesome_inc/jobs/127817`);
    expect(init.method).toBe("POST");

    const form = formToObject(init.body);
    expect(form.first_name).toBe("Mary Jane");
    expect(form.last_name).toBe("Watson");
    expect(form.email).toBe("mary@example.com");
    expect(form.phone).toBe("+1 555 0100");
    expect(form.id).toBe("127817");

    const file = form.resume as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.name).toBe("cv.pdf");
    expect(file.type).toBe("application/pdf");

    expect(result.evidenceType).toBe("greenhouse_submission");
    expect(result.payload.applicationId).toBe(987654);
    expect(result.payload.httpStatus).toBe(200);
  });

  it("sends HTTP Basic auth with the employer key as username and no password", async () => {
    const { adapter, fetchImpl } = makeAdapter({ credentials: { apiKey: "secret-key" } });

    await adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(headers.Authorization).toBe(`Basic ${Buffer.from("secret-key:").toString("base64")}`);
  });

  it("does NOT set Content-Type by hand — fetch must add the multipart boundary", async () => {
    // The classic bug: setting "multipart/form-data" manually omits the
    // boundary, so the server cannot parse any part, including the resume.
    const { adapter, fetchImpl } = makeAdapter();

    await adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("content-type");
  });

  it("accepts a 201 as success", async () => {
    const { adapter } = makeAdapter({ response: { ok: true, status: 201 } });

    const result = await adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context);

    expect(result.payload.httpStatus).toBe(201);
  });

  it("never records candidate values in the evidence payload", async () => {
    const { adapter } = makeAdapter();

    const result = await adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context);
    const serialised = JSON.stringify(result.payload);

    expect(serialised).not.toContain("mary@example.com");
    expect(serialised).not.toContain("+1 555 0100");
    expect(serialised).not.toContain("Watson");
  });
});

describe("greenhouseAdapter.submit — failure", () => {
  it("surfaces Greenhouse's own error message on a 4xx", async () => {
    const { adapter } = makeAdapter({
      response: {
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ message: "Invalid application", errors: [{ field: "email" }] }),
      },
    });
    const client = makeClient({ plan, vacancy, facts, confirmations });

    await expect(adapter.submit(client, context)).rejects.toThrow(SUBMISSION_REJECTED_REASON);
    await expect(adapter.submit(client, context)).rejects.toThrow(/Invalid application/);
  });

  it("falls back to the status line when the error body is not JSON", async () => {
    const { adapter } = makeAdapter({
      response: { ok: false, status: 502, text: async () => "<html>Bad Gateway</html>" },
    });

    await expect(adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context)).rejects.toThrow(
      /HTTP 502/,
    );
  });

  it("reports a bare status when the body cannot be read at all", async () => {
    const { adapter } = makeAdapter({
      response: {
        ok: false,
        status: 500,
        text: async () => {
          throw new Error("stream closed");
        },
      },
    });

    await expect(adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context)).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("fails before any request when the employer key is not configured", async () => {
    const { adapter, fetchImpl } = makeAdapter({
      credentials: () => {
        throw new GreenhouseCredentialsError();
      },
    });

    await expect(adapter.submit(makeClient({ plan, vacancy, facts, confirmations }), context)).rejects.toThrow(
      MISSING_CREDENTIALS_REASON,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails without a request when a mandatory contact fact is missing", async () => {
    const { adapter, fetchImpl, downloadResume } = makeAdapter();
    const client = makeClient({
      plan,
      vacancy,
      facts: facts.filter((fact) => fact.fact_type !== "phone"),
      confirmations,
    });

    await expect(adapter.submit(client, context)).rejects.toThrow(MISSING_REQUIRED_FACT_REASON);
    await expect(adapter.submit(client, context)).rejects.toThrow(/phone/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(downloadResume).not.toHaveBeenCalled();
  });

  it("fails without a request when the candidate has no resume", async () => {
    const { adapter, fetchImpl } = makeAdapter();
    const adapterWithNoResume = createGreenhouseAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readCredentials: () => ({ apiKey: "k" }),
      // Task H3: see the note in makeAdapter — the store lookup is stubbed to
      // "no row for this board" so the adapter falls back to readCredentials.
      loadCredential: async () => null,
      downloadResume: async () => {
        throw new Error(MISSING_RESUME_REASON);
      },
    });

    await expect(
      adapterWithNoResume.submit(makeClient({ plan, vacancy, facts, confirmations }), context),
    ).rejects.toThrow(MISSING_RESUME_REASON);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(adapter.sourceCode).toBe("greenhouse");
  });

  it("fails without a request when the vacancy's target cannot be resolved", async () => {
    const { adapter, fetchImpl } = makeAdapter();
    const client = makeClient({
      plan,
      vacancy: { data: { source_vacancy_id: null, authoritative_url: "https://example.test/x", vacancies_source: null } },
      facts,
      confirmations,
    });

    await expect(adapter.submit(client, context)).rejects.toThrow(UNPARSEABLE_TARGET_REASON);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
