import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_NAME } from "../shared/app.js";
import type { CreateAppOptions } from "./index.js";
import { runApplicationBatch } from "./applications/runner.js";

// Real PDF/DOCX parsing is exercised in server/resumes/textExtraction.test.ts —
// these route-level tests only care about auth/ownership/rate-limit/status-
// mapping, so the actual file bytes never need to be a real parseable document.
vi.mock("./resumes/textExtraction.js", () => ({
  extractResumeText: vi.fn().mockResolvedValue("Jordan Rivera, Backend Engineer"),
  UnsupportedResumeFormatError: class UnsupportedResumeFormatError extends Error {},
}));

// POST /api/worker/run calls runApplicationBatch directly (same "import the
// function, only the client is injectable" shape as extractResumeFacts) —
// its own internals are covered by server/applications/runner.test.ts, so
// these route-level tests only care about auth-gating and response wiring.
vi.mock("./applications/runner.js", () => ({
  runApplicationBatch: vi.fn(),
}));

const { app, createApp } = await import("./index.js");

let baseUrl: string;
let server: ReturnType<typeof app.listen>;

beforeAll(() => {
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("GET /api/health", () => {
  it("returns 200 with the service status", async () => {
    const response = await fetch(`${baseUrl}/api/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: APP_NAME,
    });
  });
});

describe("unknown routes", () => {
  it("returns 404", async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`);

    expect(response.status).toBe(404);
  });
});

describe("GET /api/me (default app, real verifyAccessToken binding)", () => {
  it("returns 401 when unauthenticated, without needing Supabase configuration", async () => {
    const response = await fetch(`${baseUrl}/api/me`);

    expect(response.status).toBe(401);
  });
});

async function withTestServer(
  options: CreateAppOptions,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const testApp = createApp(options);
  const testServer: Server = testApp.listen(0, "127.0.0.1");

  await new Promise<void>((resolve) => testServer.once("listening", resolve));
  const { port } = testServer.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      testServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("GET /api/me (injected verifier, no real network calls)", () => {
  it("returns 200 with the exact verified identity for a valid token", async () => {
    await withTestServer(
      {
        verifyAccessToken: async (token) =>
          token === "valid-test-token" ? { id: "user-123", email: "person@example.com" } : null,
        checkIsModerator: async () => false,
      },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/me`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: "user-123", email: "person@example.com", isModerator: false });
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("vary")).toBe("Authorization");
      },
    );
  });

  it("returns isModerator: true when the checker reports a moderator", async () => {
    await withTestServer(
      {
        verifyAccessToken: async (token) =>
          token === "valid-test-token" ? { id: "user-123", email: "person@example.com" } : null,
        checkIsModerator: async () => true,
      },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/me`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: "user-123", email: "person@example.com", isModerator: true });
      },
    );
  });

  it("returns 401 for an invalid token", async () => {
    await withTestServer(
      { verifyAccessToken: async () => null },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/me`, {
          headers: { Authorization: "Bearer whatever" },
        });

        expect(response.status).toBe(401);
      },
    );
  });
});

const testVerifier = async (token: string) =>
  token === "valid-test-token" ? { id: "user-123", email: "person@example.com" } : null;

function makeInsertOnlyServiceClient(result: { data: unknown; error: unknown }) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = vi.fn((table: string) => {
    const chain = (method: string) => (...args: unknown[]) => (calls.push({ table, method, args }), builder);
    const builder = {
      insert: chain("insert"),
      select: chain("select"),
      update: chain("update"),
      eq: chain("eq"),
      in: chain("in"),
      single: (...args: unknown[]) => (calls.push({ table, method: "single", args }), result),
      then: (onFulfilled: (value: typeof result) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    };
    return builder;
  });
  return { serviceClient: { from } as never, calls };
}

describe("POST /api/vacancies/:vacancyId/reports", () => {
  it("returns 401 when unauthenticated", async () => {
    await withTestServer({ verifyAccessToken: testVerifier }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/vacancies/vacancy-1/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "fake_job" }),
      });
      expect(response.status).toBe(401);
    });
  });

  it("returns 400 for an invalid category", async () => {
    await withTestServer({ verifyAccessToken: testVerifier }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/vacancies/vacancy-1/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
        body: JSON.stringify({ category: "not_a_real_category" }),
      });
      expect(response.status).toBe(400);
    });
  });

  it("returns 201 and attributes the report to the verified user, not client input", async () => {
    const { serviceClient, calls } = makeInsertOnlyServiceClient({ data: { id: "report-1" }, error: null });

    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/vacancies/vacancy-1/reports`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify({ category: "payment_request", reporterId: "someone-else" }),
        });

        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({ id: "report-1" });
        const insertCall = calls.find((call) => call.method === "insert");
        expect((insertCall?.args[0] as { reporter_id: string }).reporter_id).toBe("user-123");
      },
    );
  });
});

describe("GET /api/moderation/queue", () => {
  it("returns 401 when unauthenticated", async () => {
    await withTestServer({ verifyAccessToken: testVerifier }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/moderation/queue`);
      expect(response.status).toBe(401);
    });
  });

  it("returns 403 for an authenticated non-moderator", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsModerator: async () => false },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/moderation/queue`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(403);
      },
    );
  });

  it("returns 200 with the queue for a moderator", async () => {
    const from = vi.fn((table: string) => {
      if (table === "moderation_cases") return { select: () => ({ data: [], error: null }) };
      if (table === "moderation_decisions") return { select: () => ({ data: [], error: null }) };
      throw new Error(`Unexpected table: ${table}`);
    });

    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsModerator: async () => true, serviceClient: { from } as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/moderation/queue`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
      },
    );
  });
});

describe("POST /api/moderation/cases/:caseId/decisions", () => {
  const validBody = { decision: "blocked", rationale: "Confirmed scam pattern.", policyVersion: "r3-moderation-v1" };

  it("returns 401 when unauthenticated", async () => {
    await withTestServer({ verifyAccessToken: testVerifier }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/moderation/cases/case-1/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      expect(response.status).toBe(401);
    });
  });

  it("returns 403 for an authenticated non-moderator", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsModerator: async () => false },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/moderation/cases/case-1/decisions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify(validBody),
        });
        expect(response.status).toBe(403);
      },
    );
  });

  it("returns 400 for an invalid decision value", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsModerator: async () => true },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/moderation/cases/case-1/decisions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify({ ...validBody, decision: "not_a_real_decision" }),
        });
        expect(response.status).toBe(400);
      },
    );
  });

  it("returns 201 and attributes the decision to the verified user, not client input", async () => {
    const { serviceClient, calls } = makeInsertOnlyServiceClient({ data: { id: "decision-1" }, error: null });

    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsModerator: async () => true, serviceClient },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/moderation/cases/case-1/decisions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify({ ...validBody, reviewerId: "someone-else" }),
        });

        expect(response.status).toBe(201);
        const insertCall = calls.find((call) => call.method === "insert");
        expect((insertCall?.args[0] as { reviewer_id: string }).reviewer_id).toBe("user-123");
      },
    );
  });

  it("returns 409 when the reviewer-separation trigger rejects the decision", async () => {
    const { serviceClient } = makeInsertOnlyServiceClient({
      data: null,
      error: { message: "Reviewer separation violation", code: "P0001" },
    });

    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsModerator: async () => true, serviceClient },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/moderation/cases/case-1/decisions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify(validBody),
        });
        expect(response.status).toBe(409);
      },
    );
  });
});

describe("POST /api/resumes/:id/extract", () => {
  const RESUME_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const CANDIDATE_ID = "user-123";

  function makeResumeServiceClient(options: {
    resumeCandidateId?: string | null;
    insertResult?: { data: unknown; error: unknown };
  } = {}) {
    const resumeCandidateId = options.resumeCandidateId === undefined ? CANDIDATE_ID : options.resumeCandidateId;
    const insertResult = options.insertResult ?? {
      data: [{ id: "fact-1", fact_type: "full_name", fact_value: "Jordan Rivera" }],
      error: null,
    };

    const from = vi.fn((table: string) => {
      if (table === "resume_documents") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                resumeCandidateId === null
                  ? { data: null, error: null }
                  : {
                      data: {
                        id: RESUME_ID,
                        candidate_id: resumeCandidateId,
                        storage_path: `${resumeCandidateId}/resume.pdf`,
                        mime_type: "application/pdf",
                      },
                      error: null,
                    },
            }),
          }),
        };
      }
      if (table === "extracted_facts") {
        return { insert: () => ({ select: () => insertResult }) };
      }
      if (table === "fact_confirmations") {
        // MP-F2: extractResumeFacts also creates a pending fact_confirmations
        // row per fact — resolved as a plain success, not under test here.
        return { insert: () => Promise.resolve({ data: [{}], error: null }) };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const download = vi.fn().mockResolvedValue({
      data: { arrayBuffer: async () => new TextEncoder().encode("fake pdf bytes").buffer },
      error: null,
    });

    return { from, storage: { from: () => ({ download }) } } as never;
  }

  function makeOpenAIClient() {
    const validExtraction = {
      full_name: "Jordan Rivera",
      email: null,
      phone: null,
      location: null,
      current_title: null,
      years_of_experience: null,
      most_recent_employer: null,
      skills: [],
      education: [],
      experience: [],
    };
    return {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify(validExtraction) } }],
          }),
        },
      },
    } as never;
  }

  it("returns 401 when unauthenticated", async () => {
    await withTestServer({ verifyAccessToken: testVerifier }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/resumes/${RESUME_ID}/extract`, { method: "POST" });
      expect(response.status).toBe(401);
    });
  });

  it("returns 400 when the id is not a valid uuid", async () => {
    await withTestServer({ verifyAccessToken: testVerifier }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/resumes/not-a-uuid/extract`, {
        method: "POST",
        headers: { Authorization: "Bearer valid-test-token" },
      });
      expect(response.status).toBe(400);
    });
  });

  it("returns 404 when the resume does not exist", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeResumeServiceClient({ resumeCandidateId: null }),
        openaiClient: makeOpenAIClient(),
      },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/resumes/${RESUME_ID}/extract`, {
          method: "POST",
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(404);
      },
    );
  });

  it("returns 404 (not 403) when the resume belongs to a different candidate", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeResumeServiceClient({ resumeCandidateId: "someone-else" }),
        openaiClient: makeOpenAIClient(),
      },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/resumes/${RESUME_ID}/extract`, {
          method: "POST",
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(404);
      },
    );
  });

  it("returns 201 with the inserted facts for the owning candidate", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeResumeServiceClient(),
        openaiClient: makeOpenAIClient(),
      },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/resumes/${RESUME_ID}/extract`, {
          method: "POST",
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({
          facts: [{ id: "fact-1", factType: "full_name", factValue: "Jordan Rivera" }],
        });
      },
    );
  });

  it("rate-limits the same candidate to 5 requests per window, returning 429 on the 6th", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeResumeServiceClient(),
        openaiClient: makeOpenAIClient(),
      },
      async (testBaseUrl) => {
        const request = () =>
          fetch(`${testBaseUrl}/api/resumes/${RESUME_ID}/extract`, {
            method: "POST",
            headers: { Authorization: "Bearer valid-test-token" },
          });

        for (let i = 0; i < 5; i += 1) {
          const response = await request();
          expect(response.status).toBe(201);
        }

        const sixthResponse = await request();
        expect(sixthResponse.status).toBe(429);
      },
    );
  });
});

describe("POST /api/worker/run", () => {
  const mockRunApplicationBatch = vi.mocked(runApplicationBatch);
  const batchResult = {
    candidateIds: ["candidate-1"],
    vacancyIds: ["vacancy-1"],
    plansEvaluated: 1,
    plansEligible: 0,
    planningFailures: [],
    attemptsProcessed: 0,
  };

  it("returns 500 without calling runApplicationBatch when no secret is configured", async () => {
    await withTestServer({ workerSecret: undefined }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/worker/run`, {
        method: "POST",
        headers: { Authorization: "Bearer anything" },
      });
      expect(response.status).toBe(500);
      expect(mockRunApplicationBatch).not.toHaveBeenCalled();
    });
  });

  it("returns 401 for a missing header without calling runApplicationBatch", async () => {
    await withTestServer({ workerSecret: "correct-secret" }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/worker/run`, { method: "POST" });
      expect(response.status).toBe(401);
      expect(mockRunApplicationBatch).not.toHaveBeenCalled();
    });
  });

  it("returns 401 for the wrong secret without calling runApplicationBatch", async () => {
    await withTestServer({ workerSecret: "correct-secret" }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/worker/run`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong-secret" },
      });
      expect(response.status).toBe(401);
      expect(mockRunApplicationBatch).not.toHaveBeenCalled();
    });
  });

  it("returns 200 with the batch result for the correct secret", async () => {
    mockRunApplicationBatch.mockResolvedValueOnce(batchResult);

    await withTestServer({ workerSecret: "correct-secret", serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/worker/run`, {
        method: "POST",
        headers: { Authorization: "Bearer correct-secret" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(batchResult);
      expect(mockRunApplicationBatch).toHaveBeenCalledOnce();
    });
  });

  it("returns 500 when runApplicationBatch throws", async () => {
    mockRunApplicationBatch.mockRejectedValueOnce(new Error("db unreachable"));

    await withTestServer({ workerSecret: "correct-secret", serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/worker/run`, {
        method: "POST",
        headers: { Authorization: "Bearer correct-secret" },
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Failed to run application batch" });
    });
  });
});
