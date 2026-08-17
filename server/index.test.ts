import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app, createApp, type CreateAppOptions } from "./index.js";
import { APP_NAME } from "../shared/app.js";

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
      },
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/me`, {
          headers: { Authorization: "Bearer valid-test-token" },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: "user-123", email: "person@example.com" });
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("vary")).toBe("Authorization");
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
      single: (...args: unknown[]) => (calls.push({ table, method: "single", args }), result),
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
