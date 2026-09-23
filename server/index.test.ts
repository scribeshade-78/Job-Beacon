import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME } from "../shared/app.js";
import type { CreateAppOptions } from "./index.js";
import { runApplicationBatch } from "./applications/runner.js";
import { runMessageClassificationBatch } from "./mailbox/classifyBatch.js";
import { runApplicationMatchBatch } from "./mailbox/matchBatch.js";
import { runFitAnalysisBatch } from "./opportunities/runner.js";
import { runIngestionBatch } from "./ingestion/runner.js";
import { bulkApplyToVacancies, MAX_BULK_APPLY_VACANCIES } from "./applications/bulkApply.js";
import { IntakePolicyError } from "./intake/intake.js";
import {
  approveAttempt,
  approveOwnedAttempt,
  ApplicationAttemptNotFoundError,
  AttemptNotAwaitingReviewError,
  AttemptNotOwnedError,
  AttemptNotPreviewedError,
  generateAttemptPreview,
} from "./applications/attemptReview.js";
import { listPlans } from "./billing/plans.js";
import { createCheckoutSession, readStripeConfig } from "./billing/stripe.js";
import { cancelCandidateSubscription, getCandidateSubscription } from "./billing/subscription.js";
import { evaluateEntitlements } from "./billing/entitlements.js";
import { getAdminBilling } from "./admin/billing.js";

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

// POST /api/worker/classify-messages — same shape: internals covered by
// server/mailbox/classifyBatch.test.ts; here only auth-gating and wiring.
vi.mock("./mailbox/classifyBatch.js", () => ({
  runMessageClassificationBatch: vi.fn(),
}));

// POST /api/worker/match-messages — internals covered by
// server/mailbox/matchBatch.test.ts.
vi.mock("./mailbox/matchBatch.js", () => ({
  runApplicationMatchBatch: vi.fn(),
}));

// POST /api/worker/run-fit — internals covered by
// server/opportunities/runner.test.ts.
vi.mock("./opportunities/runner.js", () => ({
  runFitAnalysisBatch: vi.fn(),
}));

// Task H1 billing. The pure logic is covered directly by
// server/billing/*.test.ts; these route tests care about validation,
// auth-gating and status mapping, so the data layers are stubbed.
// verifyStripeSignature is deliberately NOT stubbed — the webhook tests exercise
// the real verification, which is the whole point of that route.
vi.mock("./admin/billing.js", () => ({ getAdminBilling: vi.fn() }));
vi.mock("./billing/entitlements.js", () => ({ evaluateEntitlements: vi.fn() }));
vi.mock("./billing/plans.js", async () => {
  const actual = await vi.importActual<typeof import("./billing/plans.js")>("./billing/plans.js");
  return { ...actual, listPlans: vi.fn() };
});
vi.mock("./billing/subscription.js", () => ({
  getCandidateSubscription: vi.fn(),
  cancelCandidateSubscription: vi.fn(),
  applyCheckoutCompleted: vi.fn(),
  applyProviderSubscriptionUpdate: vi.fn(),
}));
vi.mock("./billing/stripe.js", async () => {
  const actual = await vi.importActual<typeof import("./billing/stripe.js")>("./billing/stripe.js");
  return { ...actual, readStripeConfig: vi.fn(), createCheckoutSession: vi.fn() };
});

// POST /api/opportunities/refresh — internals covered by
// server/ingestion/runner.test.ts; here only auth-gating and response wiring.
vi.mock("./ingestion/runner.js", () => ({
  runIngestionBatch: vi.fn(),
}));

// POST /api/opportunities/bulk-apply — internals covered by
// server/applications/bulkApply.test.ts; here only validation, auth-gating and
// response wiring. MAX_BULK_APPLY_VACANCIES is re-exported for the limit test.
vi.mock("./applications/bulkApply.js", async () => {
  const actual = await vi.importActual<typeof import("./applications/bulkApply.js")>(
    "./applications/bulkApply.js",
  );
  return { ...actual, bulkApplyToVacancies: vi.fn() };
});

// POST /api/worker/approve-attempt — internals covered by
// server/applications/attemptReview.test.ts; here only auth-gating,
// validation and status mapping.
// Task V's two candidate-facing routes are mocked for the same reason: their
// logic is covered by attemptReview.test.ts, and what these tests are about is
// auth-gating, ownership status mapping and response wiring.
vi.mock("./applications/attemptReview.js", async () => {
  const actual = await vi.importActual<typeof import("./applications/attemptReview.js")>(
    "./applications/attemptReview.js",
  );
  return {
    ...actual,
    approveAttempt: vi.fn(),
    generateAttemptPreview: vi.fn(),
    approveOwnedAttempt: vi.fn(),
  };
});

// POST /api/intake/discover — internals covered by server/intake/intake.test.ts;
// here only auth-gating, source resolution and response wiring.
vi.mock("./intake/intake.js", async () => {
  const actual = await vi.importActual<typeof import("./intake/intake.js")>("./intake/intake.js");
  return { ...actual, runIntake: vi.fn() };
});

// Task C2's follow-up routes — internals covered by
// server/mailbox/followUpReview.test.ts; here only auth, validation and status
// mapping.
vi.mock("./mailbox/followUpReview.js", async () => {
  const actual = await vi.importActual<typeof import("./mailbox/followUpReview.js")>(
    "./mailbox/followUpReview.js",
  );
  return { ...actual, listPendingFollowUps: vi.fn(), sendFollowUpDraft: vi.fn(), dismissFollowUpDraft: vi.fn() };
});

const { app, createApp } = await import("./index.js");

import {
  dismissFollowUpDraft,
  FollowUpDraftNotFoundError,
  FollowUpDraftNotOwnedError,
  FollowUpDraftNotPendingError,
  listPendingFollowUps,
  sendFollowUpDraft,
} from "./mailbox/followUpReview.js";

import { runIntake } from "./intake/intake.js";

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
  // This previously asserted that /does-not-exist returned 404. That is no
  // longer the contract: the SPA fallback answers unmatched non-/api GETs with
  // the app shell. It is asserted on /api instead, because this global app's
  // behaviour for other paths depends on whether a client build is present
  // (the fallback is only registered when the directory exists), which would
  // make the assertion pass locally and fail on a clean checkout.
  it("returns 404 for an unknown /api route, never the app shell", async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);

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
          token === "valid-test-token" ? { id: "user-123", email: "person@example.com", aal: "aal1" as const } : null,
        checkIsModerator: async () => false,
        checkHasVerifiedEmployerClaim: async () => false,
        checkIsAdmin: async () => false,
      },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/me`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          id: "user-123",
          email: "person@example.com",
          aal: "aal1",
          isModerator: false,
          isEmployer: false,
          isAdmin: false,
        });
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("vary")).toBe("Authorization");
      },
    );
  });

  it("returns isModerator: true when the checker reports a moderator", async () => {
    await withTestServer(
      {
        verifyAccessToken: async (token) =>
          token === "valid-test-token" ? { id: "user-123", email: "person@example.com", aal: "aal1" as const } : null,
        checkIsModerator: async () => true,
        checkHasVerifiedEmployerClaim: async () => false,
        checkIsAdmin: async () => false,
      },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/me`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          id: "user-123",
          email: "person@example.com",
          aal: "aal1",
          isModerator: true,
          isEmployer: false,
          isAdmin: false,
        });
      },
    );
  });

  it("returns isAdmin: true when the checker reports an admin", async () => {
    await withTestServer(
      {
        verifyAccessToken: async (token) =>
          token === "valid-test-token" ? { id: "user-123", email: "person@example.com", aal: "aal1" as const } : null,
        checkIsModerator: async () => false,
        checkHasVerifiedEmployerClaim: async () => false,
        checkIsAdmin: async () => true,
      },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/me`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          id: "user-123",
          email: "person@example.com",
          aal: "aal1",
          isModerator: false,
          isEmployer: false,
          isAdmin: true,
        });
      },
    );
  });

  it("returns isEmployer: true when the checker reports a verified employer claim", async () => {
    await withTestServer(
      {
        verifyAccessToken: async (token) =>
          token === "valid-test-token" ? { id: "user-123", email: "person@example.com", aal: "aal1" as const } : null,
        checkIsModerator: async () => false,
        checkHasVerifiedEmployerClaim: async () => true,
        checkIsAdmin: async () => false,
      },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/me`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as { isEmployer: boolean };
        expect(body.isEmployer).toBe(true);
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
  token === "valid-test-token" ? { id: "user-123", email: "person@example.com", aal: "aal1" as const } : null;

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

describe("POST /api/opportunities/refresh", () => {
  const mockedRunIngestionBatch = vi.mocked(runIngestionBatch);

  beforeEach(() => {
    mockedRunIngestionBatch.mockReset();
  });

  it("returns 401 when unauthenticated", async () => {
    await withTestServer({ verifyAccessToken: testVerifier }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/opportunities/refresh`, { method: "POST" });

      expect(response.status).toBe(401);
      expect(mockedRunIngestionBatch).not.toHaveBeenCalled();
    });
  });

  it("returns 200 with the batch summary for a signed-in candidate", async () => {
    const batchResult = {
      targets: [
        { sourceCode: "jooble", targetKey: "us-data-engineer", status: "fetched" as const, vacanciesFetched: 50 },
        { sourceCode: "usajobs", targetKey: "us-data-engineer", status: "skipped_recent" as const, vacanciesFetched: 0 },
      ],
      vacanciesFetched: 50,
      failed: 0,
      skippedRecent: 1,
      skippedQueued: 0,
    };
    mockedRunIngestionBatch.mockResolvedValueOnce(batchResult);

    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: {} as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/opportunities/refresh`, {
          method: "POST",
          headers: { Authorization: "Bearer valid-test-token" },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(batchResult);
        // The route must hand the batch the service-role client, never a
        // request-scoped one — ingestion reads source_policies/vacancy_sources.
        expect(mockedRunIngestionBatch).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("returns 500 with a generic message when the batch throws", async () => {
    mockedRunIngestionBatch.mockRejectedValueOnce(new Error("claim_ingestion_job exploded"));

    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: {} as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/opportunities/refresh`, {
          method: "POST",
          headers: { Authorization: "Bearer valid-test-token" },
        });

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "Failed to refresh opportunities" });
      },
    );
  });
});

describe("POST /api/opportunities/bulk-apply", () => {
  const mockedBulkApply = vi.mocked(bulkApplyToVacancies);
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  beforeEach(() => {
    mockedBulkApply.mockReset();
  });

  it("returns 401 when unauthenticated", async () => {
    await withTestServer({ verifyAccessToken: testVerifier }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/opportunities/bulk-apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vacancyIds: [uuid(1)] }),
      });

      expect(response.status).toBe(401);
      expect(mockedBulkApply).not.toHaveBeenCalled();
    });
  });

  it("returns 400 when vacancyIds is missing, not an array, or empty", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: {} as never },
      async (testBaseUrl) => {
        for (const body of [{}, { vacancyIds: "nope" }, { vacancyIds: [] }]) {
          const response = await fetch(`${testBaseUrl}/api/opportunities/bulk-apply`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
            body: JSON.stringify(body),
          });

          expect(response.status).toBe(400);
        }

        expect(mockedBulkApply).not.toHaveBeenCalled();
      },
    );
  });

  it("returns 400 when any vacancy id is not a valid id", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: {} as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/opportunities/bulk-apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify({ vacancyIds: [uuid(1), "not-an-id"] }),
        });

        expect(response.status).toBe(400);
        expect(mockedBulkApply).not.toHaveBeenCalled();
      },
    );
  });

  it("returns 400 above the per-request cap", async () => {
    const tooMany = Array.from({ length: MAX_BULK_APPLY_VACANCIES + 1 }, (_, index) => uuid(index + 1));

    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: {} as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/opportunities/bulk-apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify({ vacancyIds: tooMany }),
        });

        expect(response.status).toBe(400);
        expect(mockedBulkApply).not.toHaveBeenCalled();
      },
    );
  });

  it("returns 200 with the per-vacancy gate outcomes for a valid request", async () => {
    const batchResult = {
      requested: 1,
      queued: 0,
      blocked: 1,
      errors: 0,
      outcomes: [
        {
          vacancyId: uuid(1),
          status: "blocked" as const,
          blockingGates: [{ gate: "application_support", reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE" }],
        },
      ],
    };
    mockedBulkApply.mockResolvedValueOnce(batchResult);

    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: {} as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/opportunities/bulk-apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify({ vacancyIds: [uuid(1)] }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(batchResult);
        // The candidate identity comes from the verified token, never the body.
        expect(mockedBulkApply).toHaveBeenCalledWith(expect.anything(), {
          candidateId: "user-123",
          vacancyIds: [uuid(1)],
        });
      },
    );
  });

  it("returns 500 with a generic message when the batch throws", async () => {
    mockedBulkApply.mockRejectedValueOnce(new Error("plan exploded"));

    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: {} as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/opportunities/bulk-apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify({ vacancyIds: [uuid(1)] }),
        });

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "Failed to queue applications" });
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

  it("returns 403 for a user who is neither a moderator nor an admin", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsModerator: async () => false, checkIsAdmin: async () => false },
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

  it("R8.1: an admin who is not a moderator reaches the moderation queue too", async () => {
    const from = vi.fn((table: string) => {
      if (table === "moderation_cases") return { select: () => ({ data: [], error: null }) };
      if (table === "moderation_decisions") return { select: () => ({ data: [], error: null }) };
      throw new Error(`Unexpected table: ${table}`);
    });

    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        checkIsModerator: async () => false,
        checkIsAdmin: async () => true,
        serviceClient: { from } as never,
      },
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

  it("returns 403 for a user who is neither a moderator nor an admin", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsModerator: async () => false, checkIsAdmin: async () => false },
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

describe("GET /api/admin/overview", () => {
  function makeOverviewClient() {
    const from = vi.fn((table: string) => {
      if (table === "moderation_cases") return { select: () => ({ data: [], error: null }) };
      if (table === "moderation_decisions") return { select: () => ({ data: [], error: null }) };
      if (table === "source_policies") return { select: () => ({ eq: () => ({ data: null, error: null, count: 2 }) }) };
      if (table === "candidate_profiles") return { select: () => ({ data: null, error: null, count: 7 }) };
      throw new Error(`Unexpected table: ${table}`);
    });
    return { from } as never;
  }

  it("returns 401 when unauthenticated", async () => {
    await withTestServer({ verifyAccessToken: testVerifier }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/admin/overview`);
      expect(response.status).toBe(401);
    });
  });

  it("returns 403 for an authenticated non-admin", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => false },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/overview`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(403);
      },
    );
  });

  it("returns 200 with the aggregate counts for an admin", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => true, serviceClient: makeOverviewClient() },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/overview`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          openModerationCases: 0,
          activeSources: 2,
          totalCandidates: 7,
        });
      },
    );
  });
});

describe("GET /api/admin/sources", () => {
  it("returns 403 for an authenticated non-admin", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => false },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/sources`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(403);
      },
    );
  });

  it("returns 200 with the source policy list for an admin", async () => {
    const from = vi.fn(() => ({
      select: () => ({ order: () => ({ data: [{ source_code: "greenhouse", kill_switch: false }], error: null }) }),
    }));

    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => true, serviceClient: { from } as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/sources`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([{ source_code: "greenhouse", kill_switch: false }]);
      },
    );
  });
});

describe("PATCH /api/admin/sources/:sourceCode", () => {
  it("returns 400 for a non-editable field", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => true },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/sources/greenhouse`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify({ policy_version: "hacked" }),
        });
        expect(response.status).toBe(400);
      },
    );
  });

  it("returns 400 for a non-boolean value", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => true },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/sources/greenhouse`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify({ kill_switch: "yes" }),
        });
        expect(response.status).toBe(400);
      },
    );
  });

  it("returns 400 when no editable field is provided", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => true },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/sources/greenhouse`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify({}),
        });
        expect(response.status).toBe(400);
      },
    );
  });

  it("returns 404 when the source policy does not exist", async () => {
    const from = vi.fn(() => ({
      update: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    }));

    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => true, serviceClient: { from } as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/sources/nope`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify({ kill_switch: true }),
        });
        expect(response.status).toBe(404);
      },
    );
  });

  it("returns 200 with the updated row", async () => {
    const from = vi.fn(() => ({
      update: () => ({
        eq: () => ({
          select: () => ({
            maybeSingle: async () => ({ data: { source_code: "greenhouse", kill_switch: true }, error: null }),
          }),
        }),
      }),
    }));

    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => true, serviceClient: { from } as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/sources/greenhouse`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: "Bearer valid-test-token" },
          body: JSON.stringify({ kill_switch: true }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ source_code: "greenhouse", kill_switch: true });
      },
    );
  });
});

describe("GET /api/admin/trust-scores", () => {
  it("returns 403 for an authenticated non-admin", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => false },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/trust-scores`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(403);
      },
    );
  });

  it("returns 200 with recent scores for an admin", async () => {
    const from = vi.fn(() => ({
      select: () => ({
        order: () => ({
          limit: () => ({
            data: [
              {
                id: "s-1",
                vacancy_id: "v-1",
                status: "FLAGGED",
                score: 42,
                policy_version: "r3-trust-score-v1",
                scored_at: "2026-08-16T00:00:00Z",
                vacancies: { raw_title: "Backend Engineer" },
              },
            ],
            error: null,
          }),
        }),
      }),
    }));

    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => true, serviceClient: { from } as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/trust-scores`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([
          {
            id: "s-1",
            vacancyId: "v-1",
            vacancyTitle: "Backend Engineer",
            status: "FLAGGED",
            score: 42,
            policyVersion: "r3-trust-score-v1",
            scoredAt: "2026-08-16T00:00:00Z",
          },
        ]);
      },
    );
  });
});

describe("GET /api/admin/trust-weights", () => {
  it("returns 403 for an authenticated non-admin", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => false },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/trust-weights`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(403);
      },
    );
  });

  it("returns 200 with the §12.2 dimension weights summing to 100 for an admin", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, checkIsAdmin: async () => true },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/admin/trust-weights`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(200);
        const weights = (await response.json()) as Record<string, number>;
        expect(Object.values(weights).reduce((sum, weight) => sum + weight, 0)).toBe(100);
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

describe("GET /api/candidate/follow-ups/pending", () => {
  const mockList = vi.mocked(listPendingFollowUps);
  const verifier = async (token: string) =>
    token === "candidate-token" ? { id: "cand-1", email: "c@example.com", aal: "aal1" as const } : null;

  beforeEach(() => {
    mockList.mockReset();
    mockList.mockResolvedValue([]);
  });

  it("returns 401 without a token, and reads nothing", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/pending`);

      expect(response.status).toBe(401);
      expect(mockList).not.toHaveBeenCalled();
    });
  });

  it("passes the verified user id as the candidate", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      await fetch(`${testBaseUrl}/api/candidate/follow-ups/pending`, {
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(mockList).toHaveBeenCalledWith(expect.anything(), "cand-1");
    });
  });

  it("returns the drafts", async () => {
    mockList.mockResolvedValueOnce([
      {
        draftId: "draft-1",
        applicationAttemptId: "attempt-1",
        companyName: "Acme",
        vacancyTitle: "Data Engineer III",
        vacancyUrl: "https://acme.test/jobs/3",
        daysSinceSubmission: 20,
        submittedAt: "2026-08-30T00:00:00.000Z",
        draftText: "Following up.",
        generatedAt: "2026-09-18T22:00:00.000Z",
        modelVersion: "test/model",
        promptVersion: "follow-up-v1",
      },
    ] as never);

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/pending`, {
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { followUps: unknown[] };
      expect(body.followUps).toHaveLength(1);
    });
  });

  it("returns 500 with generic copy when the read fails", async () => {
    mockList.mockRejectedValueOnce(new Error("db down"));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/pending`, {
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Could not load your follow-ups. Please try again." });
    });
  });
});

describe("POST /api/candidate/follow-ups/:id/send", () => {
  const mockSend = vi.mocked(sendFollowUpDraft);
  const draftId = "11111111-2222-4333-8444-555555555555";
  const verifier = async (token: string) =>
    token === "candidate-token" ? { id: "cand-1", email: "c@example.com", aal: "aal1" as const } : null;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({
      draftId,
      status: "sent",
      transmitted: false,
      note: "Marked as sent. No email was transmitted.",
    });
  });

  it("returns 401 without a token, and sends nothing", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/${draftId}/send`, { method: "POST" });

      expect(response.status).toBe(401);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  it("returns 400 for a non-uuid id", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/nope/send`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(400);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  it("returns 200 and reports that nothing was transmitted", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/${draftId}/send`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(200);
      // The response must never let a client conclude an email went out.
      expect(await response.json()).toMatchObject({ status: "sent", transmitted: false });
    });
  });

  it("returns 404, not 403, for another candidate's draft", async () => {
    mockSend.mockRejectedValueOnce(new FollowUpDraftNotOwnedError(draftId));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/${draftId}/send`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Follow-up draft not found." });
    });
  });

  it("returns the same 404 for a draft that does not exist", async () => {
    mockSend.mockRejectedValueOnce(new FollowUpDraftNotFoundError(draftId));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/${draftId}/send`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(404);
    });
  });

  it("returns 409 when the draft is no longer awaiting review", async () => {
    mockSend.mockRejectedValueOnce(new FollowUpDraftNotPendingError(draftId, "sent"));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/${draftId}/send`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "This follow-up is no longer awaiting your review.",
        status: "sent",
      });
    });
  });
});

describe("POST /api/candidate/follow-ups/:id/dismiss", () => {
  const mockDismiss = vi.mocked(dismissFollowUpDraft);
  const draftId = "11111111-2222-4333-8444-555555555555";
  const verifier = async (token: string) =>
    token === "candidate-token" ? { id: "cand-1", email: "c@example.com", aal: "aal1" as const } : null;

  beforeEach(() => {
    mockDismiss.mockReset();
    mockDismiss.mockResolvedValue({ draftId, status: "dismissed" });
  });

  it("returns 401 without a token", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/${draftId}/dismiss`, { method: "POST" });

      expect(response.status).toBe(401);
      expect(mockDismiss).not.toHaveBeenCalled();
    });
  });

  it("returns 200 with the dismissed status", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/${draftId}/dismiss`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ draftId, status: "dismissed" });
    });
  });

  it("returns 404 for another candidate's draft", async () => {
    mockDismiss.mockRejectedValueOnce(new FollowUpDraftNotOwnedError(draftId));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/${draftId}/dismiss`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(404);
    });
  });

  it("returns 409 when the draft is no longer awaiting review", async () => {
    mockDismiss.mockRejectedValueOnce(new FollowUpDraftNotPendingError(draftId, "dismissed"));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/candidate/follow-ups/${draftId}/dismiss`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(409);
    });
  });
});

describe("POST /api/intake/discover", () => {
  const mockIntake = vi.mocked(runIntake);
  const verifier = async (token: string) =>
    token === "candidate-token" ? { id: "cand-1", email: "c@example.com", aal: "aal1" as const } : null;

  const intakeResult = {
    sourceCode: "remotive",
    displayName: "Remotive (public remote-job API)",
    attribution: "Job data from Remotive (https://remotive.com), delayed by 24 hours.",
    search: null,
    received: 16,
    skippedByAdapter: 0,
    ingested: 3,
    trustStatusCounts: { VERIFIED_INCOMPLETE: 3 },
    outcomes: [
      { vacancyId: "new-1", title: "Data Engineer", companyName: "Acme", outcome: "created", trustStatus: "VERIFIED_INCOMPLETE" },
      { vacancyId: "new-2", title: "Data Analyst", companyName: "Acme", outcome: "created", trustStatus: "VERIFIED_INCOMPLETE" },
      { vacancyId: "old-1", title: "Old Job", companyName: "Acme", outcome: "updated", trustStatus: "VERIFIED_INCOMPLETE" },
    ],
    durationMs: 1234,
  };

  beforeEach(() => {
    mockIntake.mockReset();
    mockIntake.mockResolvedValue(intakeResult as never);
  });

  it("returns 401 without a token, and fetches nothing", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/intake/discover`, { method: "POST" });

      expect(response.status).toBe(401);
      expect(mockIntake).not.toHaveBeenCalled();
    });
  });

  it("returns 401 for a token that does not verify", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/intake/discover`, {
        method: "POST",
        headers: { Authorization: "Bearer expired" },
      });

      expect(response.status).toBe(401);
      expect(mockIntake).not.toHaveBeenCalled();
    });
  });

  it("returns 200 with the counts and the ids of what was created", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/intake/discover`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        sourceCode: "remotive",
        received: 16,
        ingested: 3,
        // 3 written, 2 of them new — the distinction the toast depends on.
        created: 2,
        updated: 1,
        newVacancyIds: ["new-1", "new-2"],
      });
    });
  });

  it("defaults to the only registered source rather than requiring one", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      await fetch(`${testBaseUrl}/api/intake/discover`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(mockIntake).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sourceCode: "remotive" }),
      );
    });
  });

  it("returns 400 for a source that is not registered, without calling intake", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/intake/discover`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token", "Content-Type": "application/json" },
        body: JSON.stringify({ sourceCode: "not-a-source" }),
      });

      expect(response.status).toBe(400);
      expect(mockIntake).not.toHaveBeenCalled();
    });
  });

  it("returns 409, not 500, when the source's policy refuses the fetch", async () => {
    mockIntake.mockRejectedValueOnce(
      new IntakePolicyError("remotive", "its kill_switch is on"),
    );

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/intake/discover`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("kill_switch is on");
    });
  });

  it("returns 500 with generic copy when the source itself fails", async () => {
    mockIntake.mockRejectedValueOnce(new Error("HTTP 503 from remotive.com"));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/intake/discover`, {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Could not fetch new jobs. Please try again." });
    });
  });
});

describe("POST /api/candidate/attempts/:id/generate-preview", () => {
  const mockPreview = vi.mocked(generateAttemptPreview);
  const attemptId = "11111111-2222-4333-8444-555555555555";
  const previewPath = (base: string) => base + "/api/candidate/attempts/" + attemptId + "/generate-preview";

  const previewResult = {
    applicationAttemptId: attemptId,
    status: "pending_review",
    resume: {
      documentId: "doc-1",
      storagePath: "cand-1/tailored.pdf",
      originalFilename: "resume-staff-data-engineer.pdf",
      mimeType: "application/pdf",
      tailored: true,
      optimizationLevel: "honest" as const,
    },
    previewUrl: "https://storage.test/cand-1/tailored.pdf?token=signed",
    previewUrlExpiresInSeconds: 300,
    resumePrepared: true,
    coverLetter: {
      kind: "generated" as const,
      text: "I am a Senior Data Engineer.\n\nMost of that work has been in Apache Spark.",
      paragraphs: [{ text: "I am a Senior Data Engineer.", factRefs: ["fact-1"] }],
      promptVersion: "cover-letter-v2",
      modelVersion: "openai/gpt-4o-mini",
      citedFactCount: 1,
      generatedAt: "2026-09-18T22:00:00.000Z",
    },
  };

  const verifier = async (token: string) =>
    token === "candidate-token" ? { id: "cand-1", email: "c@example.com", aal: "aal1" as const } : null;

  beforeEach(() => {
    mockPreview.mockReset();
  });

  it("returns 401 without a token, and prepares nothing", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(previewPath(testBaseUrl), { method: "POST" });

      expect(response.status).toBe(401);
      expect(mockPreview).not.toHaveBeenCalled();
    });
  });

  it("returns 401 for a token that does not verify", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(previewPath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer not-a-real-token" },
      });

      expect(response.status).toBe(401);
      expect(mockPreview).not.toHaveBeenCalled();
    });
  });

  it("returns 400 for a non-uuid attempt id, without touching the database", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(testBaseUrl + "/api/candidate/attempts/not-a-uuid/generate-preview", {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(400);
      expect(mockPreview).not.toHaveBeenCalled();
    });
  });

  it("passes the verified user id as the candidate, never anything from the client", async () => {
    mockPreview.mockResolvedValueOnce(previewResult);

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      await fetch(previewPath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token", "Content-Type": "application/json" },
        // A forged candidateId in the body must be ignored entirely: this route
        // reads no body at all.
        body: JSON.stringify({ candidateId: "somebody-else" }),
      });

      expect(mockPreview).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        candidateId: "cand-1",
        applicationAttemptId: attemptId,
      });
    });
  });

  it("returns 200 with the signed URL and the prepared document", async () => {
    mockPreview.mockResolvedValueOnce(previewResult);

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(previewPath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        applicationAttemptId: attemptId,
        status: "pending_review",
        previewUrl: "https://storage.test/cand-1/tailored.pdf?token=signed",
        previewUrlExpiresInSeconds: 300,
        resumePrepared: true,
        resume: {
          documentId: "doc-1",
          originalFilename: "resume-staff-data-engineer.pdf",
          tailored: true,
          optimizationLevel: "honest",
        },
        coverLetter: {
          status: "generated",
          text: "I am a Senior Data Engineer.\n\nMost of that work has been in Apache Spark.",
          promptVersion: "cover-letter-v2",
          modelVersion: "openai/gpt-4o-mini",
          citedFactCount: 1,
          generatedAt: "2026-09-18T22:00:00.000Z",
        },
      });
    });
  });

  it("returns no separate storage path or mime type, only the signed URL", async () => {
    mockPreview.mockResolvedValueOnce(previewResult);

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(previewPath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      const body = (await response.json()) as { resume: Record<string, unknown>; previewUrl: string };

      // The object path IS inside a signed URL — that is how Supabase signs,
      // and the path alone grants nothing without the token that follows it.
      // What must not appear is the path as its own reusable field, which
      // would be a durable reference to a private object with no expiry.
      expect(body.resume).not.toHaveProperty("storagePath");
      expect(body.resume).not.toHaveProperty("mimeType");
      expect(body.previewUrl).toBe(previewResult.previewUrl);
      expect(body.previewUrl).toContain("token=");
    });
  });

  it("returns 404, not 403, for another candidate's attempt, so the endpoint is not an id oracle", async () => {
    mockPreview.mockRejectedValueOnce(new AttemptNotOwnedError(attemptId));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(previewPath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Application attempt not found." });
    });
  });

  it("returns the same 404 for an attempt that does not exist at all", async () => {
    mockPreview.mockRejectedValueOnce(new ApplicationAttemptNotFoundError(attemptId));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(previewPath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      // Byte-identical to the not-owned case above: nothing distinguishes them.
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Application attempt not found." });
    });
  });

  it("returns 409 when the attempt is not awaiting review", async () => {
    mockPreview.mockRejectedValueOnce(new AttemptNotAwaitingReviewError(attemptId, "succeeded"));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(previewPath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "This application is not awaiting your review.",
        status: "succeeded",
      });
    });
  });

  it("returns 500 with generic copy when preparation fails", async () => {
    mockPreview.mockRejectedValueOnce(new Error("openrouter rejected the key"));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(previewPath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Could not prepare your resume preview." });
    });
  });
});

describe("POST /api/candidate/attempts/:id/approve", () => {
  const mockApprove = vi.mocked(approveOwnedAttempt);
  const attemptId = "11111111-2222-4333-8444-555555555555";
  const approvePath = (base: string) => base + "/api/candidate/attempts/" + attemptId + "/approve";

  const verifier = async (token: string) =>
    token === "candidate-token" ? { id: "cand-1", email: "c@example.com", aal: "aal1" as const } : null;

  beforeEach(() => {
    mockApprove.mockReset();
  });

  it("returns 401 without a token, and approves nothing", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(approvePath(testBaseUrl), { method: "POST" });

      expect(response.status).toBe(401);
      expect(mockApprove).not.toHaveBeenCalled();
    });
  });

  it("returns 401 for a token that does not verify", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(approvePath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer expired-token" },
      });

      expect(response.status).toBe(401);
      expect(mockApprove).not.toHaveBeenCalled();
    });
  });

  it("returns 400 for a non-uuid attempt id", async () => {
    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(testBaseUrl + "/api/candidate/attempts/nope/approve", {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(400);
      expect(mockApprove).not.toHaveBeenCalled();
    });
  });

  it("returns 200 and the approval timestamp on success", async () => {
    mockApprove.mockResolvedValueOnce({
      applicationAttemptId: attemptId,
      status: "pending",
      reviewApprovedAt: "2026-09-18T19:00:00.000Z",
    });

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(approvePath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        applicationAttemptId: attemptId,
        status: "pending",
        reviewApprovedAt: "2026-09-18T19:00:00.000Z",
      });
      expect(mockApprove).toHaveBeenCalledWith(expect.anything(), {
        candidateId: "cand-1",
        applicationAttemptId: attemptId,
      });
    });
  });

  it("returns 404, not 403, for another candidate's attempt", async () => {
    mockApprove.mockRejectedValueOnce(new AttemptNotOwnedError(attemptId));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(approvePath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Application attempt not found." });
    });
  });

  it("returns 409 telling the candidate to preview first when nothing was prepared", async () => {
    mockApprove.mockRejectedValueOnce(new AttemptNotPreviewedError(attemptId));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(approvePath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "Generate the resume preview before approving this application.",
      });
    });
  });

  it("returns 409 when the attempt is no longer awaiting review", async () => {
    mockApprove.mockRejectedValueOnce(new AttemptNotAwaitingReviewError(attemptId, "succeeded"));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(approvePath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "This application is not awaiting your review.",
        status: "succeeded",
      });
    });
  });

  it("returns 500 with generic copy when the release fails", async () => {
    mockApprove.mockRejectedValueOnce(new Error("db down"));

    await withTestServer({ verifyAccessToken: verifier, serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(approvePath(testBaseUrl), {
        method: "POST",
        headers: { Authorization: "Bearer candidate-token" },
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Could not approve this application." });
    });
  });
});

describe("POST /api/worker/approve-attempt", () => {
  const mockApprove = vi.mocked(approveAttempt);

  const approvalResult = {
    applicationAttemptId: "attempt-1",
    status: "pending" as const,
    reviewApprovedAt: "2026-09-18T18:00:00.000Z",
    resumePrepared: true,
    resume: {
      documentId: "doc-1",
      storagePath: "cand-1/tailored.pdf",
      originalFilename: "resume-staff-data-engineer.pdf",
      mimeType: "application/pdf",
      tailored: true,
      optimizationLevel: "honest" as const,
    },
  };

  beforeEach(() => {
    mockApprove.mockReset();
  });

  it("returns 500 without approving anything when no secret is configured", async () => {
    await withTestServer({ workerSecret: undefined }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/worker/approve-attempt`, {
        method: "POST",
        headers: { Authorization: "Bearer anything", "Content-Type": "application/json" },
        body: JSON.stringify({ applicationAttemptId: "attempt-1" }),
      });

      expect(response.status).toBe(500);
      expect(mockApprove).not.toHaveBeenCalled();
    });
  });

  it("returns 401 for a missing or wrong secret without approving anything", async () => {
    await withTestServer({ workerSecret: "correct-secret" }, async (testBaseUrl) => {
      const missing = await fetch(`${testBaseUrl}/api/worker/approve-attempt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationAttemptId: "attempt-1" }),
      });
      expect(missing.status).toBe(401);

      const wrong = await fetch(`${testBaseUrl}/api/worker/approve-attempt`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
        body: JSON.stringify({ applicationAttemptId: "attempt-1" }),
      });
      expect(wrong.status).toBe(401);

      expect(mockApprove).not.toHaveBeenCalled();
    });
  });

  it("returns 400 when applicationAttemptId is missing or blank", async () => {
    await withTestServer({ workerSecret: "correct-secret", serviceClient: {} as never }, async (testBaseUrl) => {
      const missing = await fetch(`${testBaseUrl}/api/worker/approve-attempt`, {
        method: "POST",
        headers: { Authorization: "Bearer correct-secret", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({ error: "applicationAttemptId is required" });

      const blank = await fetch(`${testBaseUrl}/api/worker/approve-attempt`, {
        method: "POST",
        headers: { Authorization: "Bearer correct-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ applicationAttemptId: "   " }),
      });
      expect(blank.status).toBe(400);

      expect(mockApprove).not.toHaveBeenCalled();
    });
  });

  it("returns 200 with the released attempt for the correct secret", async () => {
    mockApprove.mockResolvedValueOnce(approvalResult);

    await withTestServer({ workerSecret: "correct-secret", serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/worker/approve-attempt`, {
        method: "POST",
        headers: { Authorization: "Bearer correct-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ applicationAttemptId: "attempt-1" }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        applicationAttemptId: "attempt-1",
        status: "pending",
        reviewApprovedAt: "2026-09-18T18:00:00.000Z",
        resumePrepared: true,
        resume: {
          documentId: "doc-1",
          originalFilename: "resume-staff-data-engineer.pdf",
          tailored: true,
          optimizationLevel: "honest",
        },
      });
      expect(mockApprove).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { applicationAttemptId: "attempt-1" },
      );
    });
  });

  it("does not leak the storage path or mime type into the response", async () => {
    mockApprove.mockResolvedValueOnce(approvalResult);

    await withTestServer({ workerSecret: "correct-secret", serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/worker/approve-attempt`, {
        method: "POST",
        headers: { Authorization: "Bearer correct-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ applicationAttemptId: "attempt-1" }),
      });

      const body = (await response.json()) as { resume: Record<string, unknown> };
      expect(body.resume).not.toHaveProperty("storagePath");
      expect(body.resume).not.toHaveProperty("mimeType");
    });
  });

  it("returns 409, echoing the actual status, when the attempt is not awaiting review", async () => {
    mockApprove.mockRejectedValueOnce(new AttemptNotAwaitingReviewError("attempt-1", "succeeded"));

    await withTestServer({ workerSecret: "correct-secret", serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/worker/approve-attempt`, {
        method: "POST",
        headers: { Authorization: "Bearer correct-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ applicationAttemptId: "attempt-1" }),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "Application attempt is not awaiting review",
        status: "succeeded",
        detail: null,
      });
    });
  });

  it("returns 404 when no such attempt exists", async () => {
    mockApprove.mockRejectedValueOnce(new ApplicationAttemptNotFoundError("missing"));

    await withTestServer({ workerSecret: "correct-secret", serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/worker/approve-attempt`, {
        method: "POST",
        headers: { Authorization: "Bearer correct-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ applicationAttemptId: "missing" }),
      });

      expect(response.status).toBe(404);
    });
  });

  it("returns 500 with a generic message when preparation fails, so no internals leak", async () => {
    mockApprove.mockRejectedValueOnce(new Error("openrouter key sk-live-1234 rejected"));

    await withTestServer({ workerSecret: "correct-secret", serviceClient: {} as never }, async (testBaseUrl) => {
      const response = await fetch(`${testBaseUrl}/api/worker/approve-attempt`, {
        method: "POST",
        headers: { Authorization: "Bearer correct-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ applicationAttemptId: "attempt-1" }),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Failed to approve application attempt" });
    });
  });
});

describe("POST /api/worker/classify-messages", () => {
  const mockRun = vi.mocked(runMessageClassificationBatch);
  const batchResult = { scanned: 3, classified: 2, malformed: 0, errors: 1 };

  it("returns 401 for a missing/wrong secret without running the batch", async () => {
    await withTestServer({ workerSecret: "correct-secret" }, async (testBaseUrl) => {
      const missing = await fetch(`${testBaseUrl}/api/worker/classify-messages`, { method: "POST" });
      expect(missing.status).toBe(401);
      const wrong = await fetch(`${testBaseUrl}/api/worker/classify-messages`, {
        method: "POST",
        headers: { Authorization: "Bearer nope" },
      });
      expect(wrong.status).toBe(401);
      expect(mockRun).not.toHaveBeenCalled();
    });
  });

  it("returns 200 with the batch result for the correct secret", async () => {
    mockRun.mockResolvedValueOnce(batchResult);

    await withTestServer(
      { workerSecret: "correct-secret", serviceClient: {} as never, openaiClient: {} as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/worker/classify-messages`, {
          method: "POST",
          headers: { Authorization: "Bearer correct-secret" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(batchResult);
        expect(mockRun).toHaveBeenCalledOnce();
      },
    );
  });

  it("returns 500 when the batch throws", async () => {
    mockRun.mockRejectedValueOnce(new Error("openrouter down"));

    await withTestServer(
      { workerSecret: "correct-secret", serviceClient: {} as never, openaiClient: {} as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/worker/classify-messages`, {
          method: "POST",
          headers: { Authorization: "Bearer correct-secret" },
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "Failed to run message classification batch" });
      },
    );
  });
});

describe("POST /api/worker/match-messages", () => {
  const mockMatch = vi.mocked(runApplicationMatchBatch);
  const batchResult = { scanned: 4, linked: 2, review: 1, ambiguous: 0, unmatched: 1, errors: 0 };

  it("returns 401 for a missing/wrong secret without running the batch", async () => {
    await withTestServer({ workerSecret: "correct-secret" }, async (testBaseUrl) => {
      const missing = await fetch(`${testBaseUrl}/api/worker/match-messages`, { method: "POST" });
      expect(missing.status).toBe(401);
      const wrong = await fetch(`${testBaseUrl}/api/worker/match-messages`, {
        method: "POST",
        headers: { Authorization: "Bearer nope" },
      });
      expect(wrong.status).toBe(401);
      expect(mockMatch).not.toHaveBeenCalled();
    });
  });

  it("returns 200 with the batch result for the correct secret", async () => {
    mockMatch.mockResolvedValueOnce(batchResult);

    await withTestServer(
      { workerSecret: "correct-secret", serviceClient: {} as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/worker/match-messages`, {
          method: "POST",
          headers: { Authorization: "Bearer correct-secret" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(batchResult);
        expect(mockMatch).toHaveBeenCalledOnce();
      },
    );
  });

  it("returns 500 when the batch throws", async () => {
    mockMatch.mockRejectedValueOnce(new Error("db down"));

    await withTestServer(
      { workerSecret: "correct-secret", serviceClient: {} as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/worker/match-messages`, {
          method: "POST",
          headers: { Authorization: "Bearer correct-secret" },
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "Failed to run message match batch" });
      },
    );
  });
});

describe("POST /api/worker/run-fit", () => {
  const mockFit = vi.mocked(runFitAnalysisBatch);
  const batchResult = { claimed: 2, analyzed: 2, capped: 1, noJdText: 0, failed: 0 };

  it("returns 401 for a missing/wrong secret without running the batch", async () => {
    await withTestServer({ workerSecret: "correct-secret" }, async (testBaseUrl) => {
      const missing = await fetch(`${testBaseUrl}/api/worker/run-fit`, { method: "POST" });
      expect(missing.status).toBe(401);
      const wrong = await fetch(`${testBaseUrl}/api/worker/run-fit`, {
        method: "POST",
        headers: { Authorization: "Bearer nope" },
      });
      expect(wrong.status).toBe(401);
      expect(mockFit).not.toHaveBeenCalled();
    });
  });

  it("returns 200 with the batch result for the correct secret", async () => {
    mockFit.mockResolvedValueOnce(batchResult);

    await withTestServer(
      { workerSecret: "correct-secret", serviceClient: {} as never, openaiClient: {} as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/worker/run-fit`, {
          method: "POST",
          headers: { Authorization: "Bearer correct-secret" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(batchResult);
        expect(mockFit).toHaveBeenCalledOnce();
      },
    );
  });

  it("returns 500 when the batch throws", async () => {
    mockFit.mockRejectedValueOnce(new Error("openrouter down"));

    await withTestServer(
      { workerSecret: "correct-secret", serviceClient: {} as never, openaiClient: {} as never },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/worker/run-fit`, {
          method: "POST",
          headers: { Authorization: "Bearer correct-secret" },
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "Failed to run fit analysis batch" });
      },
    );
  });
});

describe("Task H1 billing routes", () => {
  const PRICED_PLAN = {
    code: "pro",
    displayName: "Pro",
    description: null,
    tierRank: 2,
    isActive: true,
    limits: null,
    prices: [
      { region: "IN", currency: "INR", billingInterval: "month" as const, amountMinor: 249900, isActive: true },
      { region: "US", currency: "USD", billingInterval: "month" as const, amountMinor: null, isActive: false },
    ],
  };

  function withAuth(extra: Partial<CreateAppOptions> = {}): CreateAppOptions {
    return { verifyAccessToken: testVerifier, serviceClient: {} as never, ...extra };
  }

  beforeEach(() => {
    vi.mocked(listPlans).mockReset();
    vi.mocked(readStripeConfig).mockReset();
    vi.mocked(createCheckoutSession).mockReset();
    vi.mocked(getCandidateSubscription).mockReset();
    vi.mocked(cancelCandidateSubscription).mockReset();
    vi.mocked(evaluateEntitlements).mockReset();
    vi.mocked(getAdminBilling).mockReset();

    vi.mocked(listPlans).mockResolvedValue([PRICED_PLAN]);
    // Default: no STRIPE_SECRET_KEY, which is this deployment's real state.
    // The stub returns not_configured to mirror what the real
    // createCheckoutSession does with a null config — a vi.fn() returning
    // undefined would test a shape the function cannot actually produce.
    vi.mocked(readStripeConfig).mockReturnValue(null);
    vi.mocked(createCheckoutSession).mockResolvedValue({ kind: "not_configured" });
    vi.mocked(getCandidateSubscription).mockResolvedValue(null);
    vi.mocked(evaluateEntitlements).mockResolvedValue({
      hasLiveSubscription: false,
      planCode: null,
      planDisplayName: null,
      evaluations: [],
      allUnconfigured: true,
    });
  });

  describe("GET /api/billing/plans", () => {
    it("returns 401 when unauthenticated", async () => {
      await withTestServer(withAuth(), async (base) => {
        expect((await fetch(base + "/api/billing/plans")).status).toBe(401);
      });
    });

    it("returns the catalogue including deliberately unpriced regions", async () => {
      await withTestServer(withAuth(), async (base) => {
        const response = await fetch(base + "/api/billing/plans", {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(200);

        const body = (await response.json()) as { plans: Array<{ code: string; prices: unknown[] }> };
        expect(body.plans).toHaveLength(1);
        // The unpriced US row is present rather than omitted, so the pricing
        // screen can say "not priced yet" instead of looking broken.
        expect(body.plans[0]?.prices).toHaveLength(2);
      });
    });
  });

  describe("POST /api/billing/checkout-session", () => {
    async function post(base: string, body: unknown) {
      return fetch(base + "/api/billing/checkout-session", {
        method: "POST",
        headers: { Authorization: "Bearer valid-test-token", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("rejects a missing plan code", async () => {
      await withTestServer(withAuth(), async (base) => {
        expect((await post(base, { region: "IN", billingInterval: "month" })).status).toBe(400);
      });
    });

    it("rejects a region outside the supported trio", async () => {
      await withTestServer(withAuth(), async (base) => {
        expect((await post(base, { planCode: "pro", region: "XX", billingInterval: "month" })).status).toBe(400);
      });
    });

    it("rejects an unknown billing interval", async () => {
      await withTestServer(withAuth(), async (base) => {
        expect((await post(base, { planCode: "pro", region: "IN", billingInterval: "week" })).status).toBe(400);
      });
    });

    it("reports 404 for a plan that does not exist", async () => {
      await withTestServer(withAuth(), async (base) => {
        expect((await post(base, { planCode: "nope", region: "IN", billingInterval: "month" })).status).toBe(404);
      });
    });

    it("refuses a region the plan is not priced for, rather than creating a free session", async () => {
      await withTestServer(withAuth(), async (base) => {
        const response = await post(base, { planCode: "pro", region: "US", billingInterval: "month" });
        expect(response.status).toBe(409);
        expect(vi.mocked(createCheckoutSession)).not.toHaveBeenCalled();
      });
    });

    it("answers 503 when no payment provider is configured, and invents no url", async () => {
      await withTestServer(withAuth(), async (base) => {
        const response = await post(base, { planCode: "pro", region: "IN", billingInterval: "month" });
        expect(response.status).toBe(503);

        const body = (await response.json()) as { error: string };
        expect(body.error).toContain("not configured");
        expect(JSON.stringify(body)).not.toContain("http");
      });
    });

    it("returns the real Stripe session url when billing is configured", async () => {
      vi.mocked(readStripeConfig).mockReturnValue({ secretKey: "sk_test", webhookSecret: null });
      vi.mocked(createCheckoutSession).mockResolvedValue({
        kind: "created",
        sessionId: "cs_1",
        url: "https://checkout.stripe.test/cs_1",
      });

      await withTestServer(withAuth(), async (base) => {
        const response = await post(base, { planCode: "pro", region: "IN", billingInterval: "month" });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ sessionId: "cs_1", url: "https://checkout.stripe.test/cs_1" });
      });
    });

    it("refuses a second subscription for a candidate who already has one", async () => {
      vi.mocked(getCandidateSubscription).mockResolvedValue({
        id: "sub-1",
        planCode: "starter",
        planDisplayName: "Starter",
        provider: "stripe",
        status: "active",
        region: "IN",
        currency: "INR",
        billingInterval: "month",
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      });

      await withTestServer(withAuth(), async (base) => {
        expect((await post(base, { planCode: "pro", region: "IN", billingInterval: "month" })).status).toBe(409);
      });
    });
  });

  describe("POST /api/billing/cancel", () => {
    it("returns 404 when there is nothing to cancel", async () => {
      vi.mocked(cancelCandidateSubscription).mockResolvedValue({ kind: "no_subscription" });

      await withTestServer(withAuth(), async (base) => {
        const response = await fetch(base + "/api/billing/cancel", {
          method: "POST",
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(404);
      });
    });

    it("explains that a paid period runs to its end", async () => {
      vi.mocked(cancelCandidateSubscription).mockResolvedValue({
        kind: "canceled",
        subscription: {
          id: "sub-1",
          planCode: "pro",
          planDisplayName: "Pro",
          provider: "stripe",
          status: "active",
          region: "IN",
          currency: "INR",
          billingInterval: "month",
          currentPeriodStart: null,
          currentPeriodEnd: "2026-10-01T00:00:00.000Z",
          cancelAtPeriodEnd: true,
        },
      });

      await withTestServer(withAuth(), async (base) => {
        const response = await fetch(base + "/api/billing/cancel", {
          method: "POST",
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(200);

        const body = (await response.json()) as { note: string };
        expect(body.note).toContain("close of the current billing period");
      });
    });
  });

  describe("POST /api/billing/webhook", () => {
    it("answers 503 rather than skipping verification when no webhook secret is set", async () => {
      await withTestServer(withAuth(), async (base) => {
        const response = await fetch(base + "/api/billing/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "checkout.session.completed" }),
        });
        expect(response.status).toBe(503);
      });
    });

    it("rejects an unsigned event with 400 and applies nothing", async () => {
      vi.mocked(readStripeConfig).mockReturnValue({ secretKey: "sk_test", webhookSecret: "whsec_test" });

      await withTestServer(withAuth(), async (base) => {
        const response = await fetch(base + "/api/billing/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
          body: JSON.stringify({ type: "checkout.session.completed", data: { object: {} } }),
        });
        expect(response.status).toBe(400);
      });
    });
  });

  describe("GET /api/admin/billing", () => {
    it("returns 403 for an authenticated non-admin", async () => {
      await withTestServer(withAuth({ checkIsAdmin: async () => false }), async (base) => {
        const response = await fetch(base + "/api/admin/billing", {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(403);
      });
    });

    it("returns the real billing payload for an admin", async () => {
      vi.mocked(getAdminBilling).mockResolvedValue({
        candidates: [],
        currencyTotals: [{ currency: "INR", monthlyRecurringRevenueMinor: 249900, payingCandidates: 1 }],
        planCounts: [{ planCode: "pro", planDisplayName: "Pro", subscribers: 1 }],
        prices: [],
        configuredLimitValues: 0,
        totalLimitValues: 27,
        truncated: false,
      });

      await withTestServer(withAuth({ checkIsAdmin: async () => true }), async (base) => {
        const response = await fetch(base + "/api/admin/billing", {
          headers: { Authorization: "Bearer valid-test-token" },
        });
        expect(response.status).toBe(200);

        const body = (await response.json()) as { currencyTotals: unknown[]; totalLimitValues: number };
        expect(body.currencyTotals).toHaveLength(1);
        expect(body.totalLimitValues).toBe(27);
      });
    });
  });
});

// SPA fallback. Uses an injected clientBuildPath pointing at a temp fixture
// rather than dist/client, so these assertions hold on a fresh clone where no
// build has been run (dist/ is gitignored and absent in CI).
describe("SPA fallback for the built client", () => {
  const SHELL = "<!doctype html><title>JobBeacon shell</title>";

  async function withClientBuild(run: (clientBuildPath: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(path.join(tmpdir(), "jobbeacon-client-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), SHELL);
    writeFileSync(path.join(dir, "assets", "app.js"), "console.log('real asset');");

    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("serves the app shell for a deep link instead of Express's Cannot GET page", async () => {
    await withClientBuild((clientBuildPath) =>
      withTestServer({ clientBuildPath }, async (base) => {
        const response = await fetch(`${base}/resumes`);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(SHELL);
      }),
    );
  });

  it("still serves a real static asset rather than the shell", async () => {
    await withClientBuild((clientBuildPath) =>
      withTestServer({ clientBuildPath }, async (base) => {
        const response = await fetch(`${base}/assets/app.js`);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("console.log('real asset');");
      }),
    );
  });

  it("does not answer an unknown /api path with the shell", async () => {
    await withClientBuild((clientBuildPath) =>
      withTestServer({ clientBuildPath }, async (base) => {
        const response = await fetch(`${base}/api/definitely-not-a-route`);

        // The negative lookahead keeps a JSON client from receiving HTML.
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("JobBeacon shell");
      }),
    );
  });

  it("registers no fallback when the client build is absent", async () => {
    await withTestServer(
      { clientBuildPath: path.join(tmpdir(), "jobbeacon-client-does-not-exist") },
      async (base) => {
        const response = await fetch(`${base}/resumes`);

        expect(response.status).toBe(404);
      },
    );
  });
});

// Interview Preparation Phase 1. The application logic is covered exhaustively
// in server/interview/interviewPrep.test.ts against a fake client; these assert
// the route wiring only — auth, id validation, and the status-code mapping.
describe("POST /api/vacancies/:vacancyId/interview-prep", () => {
  const VACANCY_ID = "11111111-1111-1111-1111-111111111111";

  const PREP = {
    technical_questions: [{ question: "How do you tune Postgres?", topic: "Postgres", why: "The JD requires it." }],
    behavioral_questions: [{ question: "Describe a conflict.", competency: "conflict resolution", why: "Cross-team." }],
    star_talking_points: [],
    gaps: [],
  };

  /**
   * Chainable and awaitable, like the real builder: the module awaits `.eq()`
   * for the list queries and calls `.maybeSingle()` for the single-row ones.
   */
  function makeInterviewServiceClient(over: Record<string, { data: unknown; error?: unknown }> = {}) {
    const tables: Record<string, { data: unknown; error?: unknown }> = {
      vacancies: { data: { raw_title: "Senior Platform Engineer" } },
      vacancy_jd_snapshots: { data: { clean_text: "We need a platform engineer with Postgres and Go." } },
      extracted_facts: { data: [{ id: "f1", fact_type: "skill", fact_value: "Postgres" }] },
      fact_confirmations: { data: [{ extracted_fact_id: "f1", corrected_value: null }] },
      ...over,
    };

    function builderFor(table: string) {
      const result = tables[table] ?? { data: [], error: null };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;

      for (const method of ["select", "eq", "in", "order", "limit"]) {
        builder[method] = chain;
      }

      builder.maybeSingle = () => Promise.resolve(result);
      builder.then = (resolve: (value: unknown) => unknown) => resolve(result);

      return builder;
    }

    return { from: (table: string) => builderFor(table) } as never;
  }

  function makeInterviewOpenAIClient(content: string = JSON.stringify(PREP)) {
    return {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } },
    } as never;
  }

  function post(base: string, vacancyId: string, options: { auth?: boolean } = {}) {
    return fetch(`${base}/api/vacancies/${vacancyId}/interview-prep`, {
      method: "POST",
      headers: options.auth === false ? {} : { Authorization: "Bearer valid-test-token" },
    });
  }

  it("returns 401 when unauthenticated", async () => {
    await withTestServer({ verifyAccessToken: testVerifier, serviceClient: makeInterviewServiceClient() }, async (base) => {
      const response = await post(base, VACANCY_ID, { auth: false });

      expect(response.status).toBe(401);
    });
  });

  it("returns 400 for a vacancy id that is not a uuid", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeInterviewServiceClient(),
        openaiClient: makeInterviewOpenAIClient(),
      },
      async (base) => {
        const response = await post(base, "not-a-uuid");

        expect(response.status).toBe(400);
      },
    );
  });

  it("returns 404 when the vacancy does not exist", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeInterviewServiceClient({ vacancies: { data: null } }),
        openaiClient: makeInterviewOpenAIClient(),
      },
      async (base) => {
        const response = await post(base, VACANCY_ID);

        expect(response.status).toBe(404);
      },
    );
  });

  it("returns 422 when the vacancy has no JD text", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeInterviewServiceClient({ vacancy_jd_snapshots: { data: null } }),
        openaiClient: makeInterviewOpenAIClient(),
      },
      async (base) => {
        const response = await post(base, VACANCY_ID);

        expect(response.status).toBe(422);
        expect(await response.json()).toHaveProperty("error");
      },
    );
  });

  it("returns 200 with the generated prep", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeInterviewServiceClient(),
        openaiClient: makeInterviewOpenAIClient(),
      },
      async (base) => {
        const response = await post(base, VACANCY_ID);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(PREP);
      },
    );
  });

  it("returns 422 for malformed AI output rather than 200 with a partial body", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeInterviewServiceClient(),
        openaiClient: makeInterviewOpenAIClient("not json"),
      },
      async (base) => {
        const response = await post(base, VACANCY_ID);

        expect(response.status).toBe(422);
      },
    );
  });

  it("marks the response no-store — prep is per-candidate and not cached", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeInterviewServiceClient(),
        openaiClient: makeInterviewOpenAIClient(),
      },
      async (base) => {
        const response = await post(base, VACANCY_ID);

        expect(response.headers.get("cache-control")).toBe("no-store");
      },
    );
  });
});

