import { describe, expect, it, vi } from "vitest";
import {
  createRequireEmployerOf,
  hasVerifiedEmployerClaim,
  isVerifiedEmployerOf,
} from "./requireEmployer.js";
import type { AuthenticatedRequest } from "./requireAuth.js";

function makeResponse() {
  const response: { statusCode?: number; body?: unknown; status: (code: number) => typeof response; json: (body: unknown) => typeof response } = {
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(body: unknown) {
      response.body = body;
      return response;
    },
  };
  return response;
}

describe("isVerifiedEmployerOf", () => {
  function makeClient(result: { data: unknown; error: unknown }) {
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => result),
    };
    return { from: vi.fn(() => builder) } as unknown as Parameters<typeof isVerifiedEmployerOf>[2];
  }

  it("returns true when a verified claim exists for that user+company", async () => {
    const client = makeClient({ data: { id: "claim-1" }, error: null });
    await expect(isVerifiedEmployerOf("user-1", "company-1", client)).resolves.toBe(true);
  });

  it("returns false when no matching row exists", async () => {
    const client = makeClient({ data: null, error: null });
    await expect(isVerifiedEmployerOf("user-1", "company-1", client)).resolves.toBe(false);
  });

  it("throws when the query errors", async () => {
    const client = makeClient({ data: null, error: { message: "db error" } });
    await expect(isVerifiedEmployerOf("user-1", "company-1", client)).rejects.toBeTruthy();
  });
});

describe("hasVerifiedEmployerClaim", () => {
  function makeClient(result: { data: unknown; error: unknown }) {
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => result),
    };
    return { from: vi.fn(() => builder) } as unknown as Parameters<typeof hasVerifiedEmployerClaim>[1];
  }

  it("returns true when at least one verified claim exists", async () => {
    const client = makeClient({ data: { id: "claim-1" }, error: null });
    await expect(hasVerifiedEmployerClaim("user-1", client)).resolves.toBe(true);
  });

  it("returns false when no verified claim exists", async () => {
    const client = makeClient({ data: null, error: null });
    await expect(hasVerifiedEmployerClaim("user-1", client)).resolves.toBe(false);
  });
});

describe("createRequireEmployerOf", () => {
  const getCompanyId = (request: AuthenticatedRequest) => request.params.companyId as string | undefined;

  it("returns 401 when there is no authenticated user", async () => {
    const checkIsVerifiedEmployer = vi.fn();
    const middleware = createRequireEmployerOf(getCompanyId, checkIsVerifiedEmployer);
    const request = { params: { companyId: "company-1" } } as unknown as AuthenticatedRequest;
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(response.statusCode).toBe(401);
    expect(checkIsVerifiedEmployer).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 400 when the route has no resolvable companyId", async () => {
    const checkIsVerifiedEmployer = vi.fn();
    const middleware = createRequireEmployerOf(() => undefined, checkIsVerifiedEmployer);
    const request = { user: { id: "user-1", email: "a@test.local", aal: "aal2" }, params: {} } as unknown as AuthenticatedRequest;
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(response.statusCode).toBe(400);
    expect(checkIsVerifiedEmployer).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden when the user has no verified claim for that company", async () => {
    const checkIsVerifiedEmployer = vi.fn().mockResolvedValue(false);
    const middleware = createRequireEmployerOf(getCompanyId, checkIsVerifiedEmployer);
    const request = {
      user: { id: "user-1", email: "a@test.local", aal: "aal2" },
      params: { companyId: "company-1" },
    } as unknown as AuthenticatedRequest;
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(checkIsVerifiedEmployer).toHaveBeenCalledWith("user-1", "company-1");
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: "Forbidden" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 mfa_required when verified but the session isn't aal2", async () => {
    const checkIsVerifiedEmployer = vi.fn().mockResolvedValue(true);
    const middleware = createRequireEmployerOf(getCompanyId, checkIsVerifiedEmployer);
    const request = {
      user: { id: "user-1", email: "a@test.local", aal: "aal1" },
      params: { companyId: "company-1" },
    } as unknown as AuthenticatedRequest;
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: "mfa_required" });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when verified and aal2", async () => {
    const checkIsVerifiedEmployer = vi.fn().mockResolvedValue(true);
    const middleware = createRequireEmployerOf(getCompanyId, checkIsVerifiedEmployer);
    const request = {
      user: { id: "user-1", email: "a@test.local", aal: "aal2" },
      params: { companyId: "company-1" },
    } as unknown as AuthenticatedRequest;
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBeUndefined();
  });
});
