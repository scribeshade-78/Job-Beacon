import { describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AccessTokenVerifier } from "../requireAuth.js";
import type { CreateAppOptions } from "../index.js";
import { AGENT_ACTION_RATE_LIMIT_MAX, AGENT_RATE_LIMIT_MAX } from "../../shared/agent.js";

/**
 * Route-level tests for POST /api/agent/chat.
 *
 * The application logic has its own coverage in chat.test.ts; what is asserted
 * here is the HTTP contract — status mapping, auth, the request-shape refusals,
 * the model whitelist and the per-candidate rate limit.
 *
 * Kept out of index.test.ts on purpose: that file is already the largest in the
 * repository, and a self-contained suite makes the whole feature's surface
 * readable in one place.
 */

/**
 * The action route delegates to bulkApplyToVacancies, so it is mocked: these
 * tests are about the HTTP contract — auth, the whitelist, status mapping and
 * the tighter rate limit — not about the eligibility engine, which
 * actions.test.ts and bulkApply's own suite already cover.
 */
vi.mock("../applications/bulkApply.js", () => ({
  MAX_BULK_APPLY_VACANCIES: 100,
  bulkApplyToVacancies: vi.fn(),
}));

import { bulkApplyToVacancies } from "../applications/bulkApply.js";

const bulkApplyMock = vi.mocked(bulkApplyToVacancies);

const { createApp } = await import("../index.js");

const testVerifier: AccessTokenVerifier = async (token) =>
  token === "valid-test-token"
    ? { id: "user-123", email: "person@example.com", aal: "aal1" as const }
    : null;

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

function makeServiceClient(tables: Record<string, unknown> = {}) {
  return {
    from: (table: string) => {
      const result = { data: tables[table] ?? [], error: null };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;

      for (const method of ["select", "eq", "in", "order", "limit"]) {
        builder[method] = chain;
      }

      builder.then = (resolve: (value: unknown) => unknown) => resolve(result);

      return builder;
    },
  } as never;
}

function makeOpenAIClient(content: string | null = "You have two eligible plans.") {
  return {
    chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } },
  } as never;
}

const VALID_BODY = { messages: [{ role: "user", content: "What are my plans?" }] };

function post(base: string, body: unknown, token: string | null = "valid-test-token") {
  return fetch(`${base}/api/agent/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agent/chat", () => {
  it("returns 401 when unauthenticated", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: makeServiceClient() },
      async (base) => {
        const response = await post(base, VALID_BODY, null);

        expect(response.status).toBe(401);
      },
    );
  });

  it("returns 200 with the answer and the model that produced it", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeServiceClient(),
        openaiClient: makeOpenAIClient(),
      },
      async (base) => {
        const response = await post(base, VALID_BODY);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          message: "You have two eligible plans.",
          model: "openai/gpt-4o-mini",
          proposals: [],
        });
        // One candidate's answer must not be held by a shared proxy.
        expect(response.headers.get("cache-control")).toBe("no-store");
      },
    );
  });

  it("returns 400 for a body with no transcript", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeServiceClient(),
        openaiClient: makeOpenAIClient(),
      },
      async (base) => {
        const response = await post(base, {});

        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("messages");
      },
    );
  });

  /**
   * The whitelist is the reason this route cannot be used to spend against an
   * arbitrary model, so a client naming one must be refused rather than
   * silently downgraded.
   */
  it("returns 400 for a model outside the whitelist", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeServiceClient(),
        openaiClient: makeOpenAIClient(),
      },
      async (base) => {
        const response = await post(base, { ...VALID_BODY, model: "anthropic/claude-3.5-sonnet" });

        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe("model is not one of the available models.");
      },
    );
  });

  it("returns 200 for a whitelisted model and reports it back", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeServiceClient(),
        openaiClient: makeOpenAIClient(),
      },
      async (base) => {
        const response = await post(base, { ...VALID_BODY, model: "anthropic/claude-sonnet-4.5" });

        expect(response.status).toBe(200);
        expect((await response.json()).model).toBe("anthropic/claude-sonnet-4.5");
      },
    );
  });

  it("returns 502 when the model answers with nothing usable", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeServiceClient(),
        openaiClient: makeOpenAIClient(""),
      },
      async (base) => {
        const response = await post(base, VALID_BODY);

        expect(response.status).toBe(502);
        expect((await response.json()).error).toContain("empty response");
      },
    );
  });

  it("returns 500 when the candidate context cannot be read", async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: {
          from: () => {
            throw new Error("PostgREST unreachable");
          },
        } as never,
        openaiClient: makeOpenAIClient(),
      },
      async (base) => {
        const response = await post(base, VALID_BODY);

        expect(response.status).toBe(500);
        expect((await response.json()).error).toBe("PostgREST unreachable");
      },
    );
  });

  it(`rate-limits a candidate to ${AGENT_RATE_LIMIT_MAX} messages per window`, async () => {
    await withTestServer(
      {
        verifyAccessToken: testVerifier,
        serviceClient: makeServiceClient(),
        openaiClient: makeOpenAIClient(),
      },
      async (base) => {
        for (let attempt = 0; attempt < AGENT_RATE_LIMIT_MAX; attempt += 1) {
          const response = await post(base, VALID_BODY);
          expect(response.status).toBe(200);
        }

        const limited = await post(base, VALID_BODY);

        expect(limited.status).toBe(429);
        expect((await limited.json()).error).toContain("Too many Copilot messages");
      },
    );
  });
});

describe("POST /api/agent/actions/execute", () => {
  const VACANCY_ID = "11111111-1111-1111-1111-111111111111";
  const OTHER_VACANCY_ID = "22222222-2222-2222-2222-222222222222";

  const QUEUED = {
    requested: 1,
    queued: 1,
    blocked: 0,
    errors: 0,
    outcomes: [{ vacancyId: VACANCY_ID, status: "queued" as const, blockingGates: [] }],
  };

  /** Serves the vacancy lookup buildAgentProposal does, which the chat route path also uses. */
  function makeActionServiceClient() {
    return {
      from: (table: string) => {
        const data =
          table === "vacancies"
            ? [{ id: VACANCY_ID, raw_title: "Platform Engineer", companies: { displayed_name: "Acme" } }]
            : [];
        const builder: Record<string, unknown> = {};
        const chain = () => builder;

        // "insert" is in this list because the action route writes an audit
        // event through the same client; without it recordAuditEvent fails and
        // logs a warning that would drown the output these tests produce.
        for (const method of ["select", "eq", "in", "order", "limit", "insert"]) {
          builder[method] = chain;
        }

        builder.then = (resolve: (value: unknown) => unknown) => resolve({ data, error: null });

        return builder;
      },
    } as never;
  }

  function execute(base: string, body: unknown, token: string | null = "valid-test-token") {
    return fetch(`${base}/api/agent/actions/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
  }

  const VALID_ACTION = { tool: "queue_applications", arguments: { vacancyIds: [VACANCY_ID] } };

  it("returns 401 when unauthenticated", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: makeActionServiceClient() },
      async (base) => {
        const response = await execute(base, VALID_ACTION, null);

        expect(response.status).toBe(401);
      },
    );
  });

  /**
   * The whitelist is the enforcement for the denylist: a client asking for the
   * very actions R4 refused must be turned away by name, not by luck.
   */
  it("returns 400 for a denied or unknown tool", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: makeActionServiceClient() },
      async (base) => {
        for (const tool of ["send_follow_up_email", "submit_application", "cancel_subscription", "nope"]) {
          const response = await execute(base, { tool, arguments: {} });

          expect(response.status).toBe(400);
          expect((await response.json()).error).toBe("tool is not one of the available actions.");
        }
      },
    );
  });

  it("returns 400 when the tool rejects the arguments", async () => {
    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: makeActionServiceClient() },
      async (base) => {
        const response = await execute(base, {
          tool: "queue_applications",
          arguments: { vacancyIds: ["not-a-uuid"] },
        });

        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("vacancyId");
        expect(bulkApplyMock).not.toHaveBeenCalled();
      },
    );
  });

  it("returns 200 with the summary and the per-vacancy detail", async () => {
    bulkApplyMock.mockResolvedValue(QUEUED);

    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: makeActionServiceClient() },
      async (base) => {
        const response = await execute(base, VALID_ACTION);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          status: "executed",
          tool: "queue_applications",
          summary: "Queued 1 of 1.",
          detail: QUEUED,
        });
        expect(response.headers.get("cache-control")).toBe("no-store");
      },
    );
  });

  it("scopes the action to the verified candidate, never the body", async () => {
    bulkApplyMock.mockResolvedValue(QUEUED);

    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: makeActionServiceClient() },
      async (base) => {
        // A body carrying someone else's candidateId must not influence the write.
        await execute(base, { ...VALID_ACTION, candidateId: "someone-else" });
        await execute(base, { ...VALID_ACTION, arguments: { ...VALID_ACTION.arguments, candidateId: "someone-else" } });

        for (const call of bulkApplyMock.mock.calls) {
          expect(call[1]).toMatchObject({ candidateId: "user-123" });
        }
      },
    );
  });

  it("returns 500 when the action fails at the infrastructure level", async () => {
    bulkApplyMock.mockRejectedValue(new Error("PostgREST unreachable"));

    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: makeActionServiceClient() },
      async (base) => {
        const response = await execute(base, VALID_ACTION);

        expect(response.status).toBe(500);
        expect((await response.json()).error).toBe("PostgREST unreachable");
      },
    );
  });

  /**
   * Executions write, so they are bounded more tightly than chat. Asserted as a
   * RELATIONSHIP rather than a literal, so raising one limit without the other
   * fails the test that states the intent.
   */
  it("rate-limits executions more tightly than chat", async () => {
    bulkApplyMock.mockResolvedValue(QUEUED);

    await withTestServer(
      { verifyAccessToken: testVerifier, serviceClient: makeActionServiceClient() },
      async (base) => {
        expect(AGENT_ACTION_RATE_LIMIT_MAX).toBeLessThan(AGENT_RATE_LIMIT_MAX);

        for (let attempt = 0; attempt < AGENT_ACTION_RATE_LIMIT_MAX; attempt += 1) {
          const response = await execute(base, VALID_ACTION);
          expect(response.status).toBe(200);
        }

        const limited = await execute(base, VALID_ACTION);

        expect(limited.status).toBe(429);
        expect((await limited.json()).error).toContain("Too many Copilot actions");
      },
    );
  });
});
