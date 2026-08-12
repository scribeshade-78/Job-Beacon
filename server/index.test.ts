import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, createApp } from "./index.js";
import { APP_NAME } from "../shared/app.js";
import type { AccessTokenVerifier } from "./requireAuth.js";

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
  verifyAccessToken: AccessTokenVerifier,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const testApp = createApp({ verifyAccessToken });
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
      async (token) =>
        token === "valid-test-token" ? { id: "user-123", email: "person@example.com" } : null,
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
      async () => null,
      async (testBaseUrl) => {
        const response = await fetch(`${testBaseUrl}/api/me`, {
          headers: { Authorization: "Bearer whatever" },
        });

        expect(response.status).toBe(401);
      },
    );
  });
});
