import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createRequireWorkerSecret } from "./requireWorkerSecret.js";

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

function createMockRequest(authorizationHeader: string | undefined): Request {
  return { header: () => authorizationHeader } as unknown as Request;
}

describe("createRequireWorkerSecret", () => {
  it("returns 500 without checking the header when no secret is configured", () => {
    const middleware = createRequireWorkerSecret(undefined);
    const request = createMockRequest("Bearer anything");
    const { response, mockResponse } = createMockResponse();
    const next = vi.fn();

    middleware(request, mockResponse, next);

    expect(response.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for a missing header", () => {
    const middleware = createRequireWorkerSecret("correct-secret");
    const request = createMockRequest(undefined);
    const { response, mockResponse } = createMockResponse();
    const next = vi.fn();

    middleware(request, mockResponse, next);

    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for a malformed header", () => {
    const middleware = createRequireWorkerSecret("correct-secret");
    const request = createMockRequest("Basic correct-secret");
    const { response, mockResponse } = createMockResponse();
    const next = vi.fn();

    middleware(request, mockResponse, next);

    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong secret of the same length", () => {
    const middleware = createRequireWorkerSecret("correct-secret");
    const request = createMockRequest("Bearer wrong-secretx".slice(0, "Bearer correct-secret".length));
    const { response, mockResponse } = createMockResponse();
    const next = vi.fn();

    middleware(request, mockResponse, next);

    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong secret of a different length (no crash from timingSafeEqual)", () => {
    const middleware = createRequireWorkerSecret("correct-secret");
    const request = createMockRequest("Bearer short");
    const { response, mockResponse } = createMockResponse();
    const next = vi.fn();

    expect(() => middleware(request, mockResponse, next)).not.toThrow();
    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next for the correct secret", () => {
    const middleware = createRequireWorkerSecret("correct-secret");
    const request = createMockRequest("Bearer correct-secret");
    const { response, mockResponse } = createMockResponse();
    const next = vi.fn();

    middleware(request, mockResponse, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.statusCode).toBeUndefined();
  });

  it("never logs the secret, on success or failure", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secretValue = "super-secret-worker-token";

    const middleware = createRequireWorkerSecret(secretValue);
    const request = createMockRequest(`Bearer ${secretValue}`);
    const { mockResponse } = createMockResponse();
    const next = vi.fn();

    middleware(request, mockResponse, next);

    const loggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
    expect(loggedText).not.toContain(secretValue);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
