import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  createRequireAuth,
  parseBearerToken,
  type AuthenticatedRequest,
} from "./requireAuth.js";

function createMockResponse() {
  const response = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
  };
  const mock = {
    status: vi.fn((code: number) => {
      response.statusCode = code;
      return mock;
    }),
    json: vi.fn((body: unknown) => {
      response.body = body;
      return mock;
    }),
  };
  return { response, mockResponse: mock as unknown as Response };
}

function createMockRequest(authorizationHeader: string | undefined): AuthenticatedRequest {
  return { header: () => authorizationHeader } as unknown as AuthenticatedRequest;
}

describe("parseBearerToken", () => {
  it("rejects a missing header", () => {
    expect(parseBearerToken(undefined)).toBeNull();
  });

  it("rejects an empty header", () => {
    expect(parseBearerToken("")).toBeNull();
  });

  it("rejects a non-Bearer scheme", () => {
    expect(parseBearerToken("Basic abc123")).toBeNull();
  });

  it("rejects Bearer with no token", () => {
    expect(parseBearerToken("Bearer")).toBeNull();
  });

  it("rejects Bearer with an empty/whitespace token", () => {
    expect(parseBearerToken("Bearer    ")).toBeNull();
  });

  it("rejects comma-separated / multiple credential values", () => {
    expect(parseBearerToken("Bearer token1, Bearer token2")).toBeNull();
  });

  it("rejects malformed multi-part values", () => {
    expect(parseBearerToken("Bearer token1 token2")).toBeNull();
  });

  it("accepts a case-insensitive Bearer scheme", () => {
    expect(parseBearerToken("bearer abc123")).toBe("abc123");
    expect(parseBearerToken("BEARER abc123")).toBe("abc123");
  });

  it("accepts a well-formed Bearer token", () => {
    expect(parseBearerToken("Bearer abc123")).toBe("abc123");
  });
});

describe("createRequireAuth", () => {
  it("returns 401 for a missing header without calling verify", async () => {
    const verify = vi.fn();
    const middleware = createRequireAuth(verify);
    const request = createMockRequest(undefined);
    const { response, mockResponse } = createMockResponse();
    const next = vi.fn();

    await middleware(request, mockResponse, next);

    expect(verify).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for a malformed header without calling verify", async () => {
    const verify = vi.fn();
    const middleware = createRequireAuth(verify);
    const request = createMockRequest("Basic abc123");
    const { response, mockResponse } = createMockResponse();
    const next = vi.fn();

    await middleware(request, mockResponse, next);

    expect(verify).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 for a comma-separated/multiple header value without calling verify", async () => {
    const verify = vi.fn();
    const middleware = createRequireAuth(verify);
    const request = createMockRequest("Bearer token1, Bearer token2");
    const { response, mockResponse } = createMockResponse();
    const next = vi.fn();

    await middleware(request, mockResponse, next);

    expect(verify).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 when verify resolves null (invalid/expired token)", async () => {
    const verify = vi.fn().mockResolvedValue(null);
    const middleware = createRequireAuth(verify);
    const request = createMockRequest("Bearer bad-token");
    const { response, mockResponse } = createMockResponse();
    const next = vi.fn();

    await middleware(request, mockResponse, next);

    expect(verify).toHaveBeenCalledWith("bad-token");
    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("sets request.user and calls next for a valid token", async () => {
    const verify = vi.fn().mockResolvedValue({ id: "user-1", email: "a@example.com" });
    const middleware = createRequireAuth(verify);
    const request = createMockRequest("Bearer good-token");
    const { response, mockResponse } = createMockResponse();
    const next = vi.fn();

    await middleware(request, mockResponse, next);

    expect(request.user).toEqual({ id: "user-1", email: "a@example.com" });
    expect(next).toHaveBeenCalledOnce();
    expect(response.statusCode).toBeUndefined();
  });

  it("never logs the token, on success or failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secretToken = "super-secret-token-value";

    const verify = vi.fn().mockResolvedValue(null);
    const middleware = createRequireAuth(verify);
    const request = createMockRequest(`Bearer ${secretToken}`);
    const { mockResponse } = createMockResponse();
    const next = vi.fn();

    await middleware(request, mockResponse, next);

    const loggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
    expect(loggedText).not.toContain(secretToken);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
