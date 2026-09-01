import { describe, expect, it, vi } from "vitest";
import { createRequireAdmin, isAdmin } from "./requireAdmin.js";
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

describe("createRequireAdmin", () => {
  it("returns 401 when there is no authenticated user", async () => {
    const checkIsAdmin = vi.fn();
    const middleware = createRequireAdmin(checkIsAdmin);
    const request = {} as AuthenticatedRequest;
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(response.statusCode).toBe(401);
    expect(checkIsAdmin).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when the authenticated user is not an admin", async () => {
    const checkIsAdmin = vi.fn().mockResolvedValue(false);
    const middleware = createRequireAdmin(checkIsAdmin);
    const request = { user: { id: "user-1", email: "a@test.local" } } as AuthenticatedRequest;
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(checkIsAdmin).toHaveBeenCalledWith("user-1");
    expect(response.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when the authenticated user is an admin", async () => {
    const checkIsAdmin = vi.fn().mockResolvedValue(true);
    const middleware = createRequireAdmin(checkIsAdmin);
    const request = { user: { id: "user-1", email: "a@test.local" } } as AuthenticatedRequest;
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBeUndefined();
  });
});

describe("isAdmin", () => {
  function makeClient(result: { data: unknown; error: unknown }) {
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => result),
    };
    return { from: vi.fn(() => builder) } as unknown as Parameters<typeof isAdmin>[1];
  }

  it("returns true when a matching user_roles row exists", async () => {
    const client = makeClient({ data: { role: "admin" }, error: null });
    await expect(isAdmin("user-1", client)).resolves.toBe(true);
  });

  it("returns false when no matching row exists", async () => {
    const client = makeClient({ data: null, error: null });
    await expect(isAdmin("user-1", client)).resolves.toBe(false);
  });

  it("throws when the query errors", async () => {
    const client = makeClient({ data: null, error: { message: "db error" } });
    await expect(isAdmin("user-1", client)).rejects.toBeTruthy();
  });
});
