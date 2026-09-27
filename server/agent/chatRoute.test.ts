import { describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AccessTokenVerifier } from "../requireAuth.js";
import type { CreateAppOptions } from "../index.js";
import { AGENT_RATE_LIMIT_MAX } from "../../shared/agent.js";

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
