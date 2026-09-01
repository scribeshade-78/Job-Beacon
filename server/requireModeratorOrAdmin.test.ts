import { describe, expect, it, vi } from "vitest";
import { createRequireModeratorOrAdmin } from "./requireModeratorOrAdmin.js";
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

const request = { user: { id: "user-1", email: "a@test.local" } } as AuthenticatedRequest;

describe("createRequireModeratorOrAdmin", () => {
  it("returns 401 when there is no authenticated user", async () => {
    const checkIsModerator = vi.fn();
    const checkIsAdmin = vi.fn();
    const middleware = createRequireModeratorOrAdmin(checkIsModerator, checkIsAdmin);
    const response = makeResponse();
    const next = vi.fn();

    await middleware({} as AuthenticatedRequest, response as never, next);

    expect(response.statusCode).toBe(401);
    expect(checkIsModerator).not.toHaveBeenCalled();
    expect(checkIsAdmin).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is neither a moderator nor an admin", async () => {
    const checkIsModerator = vi.fn().mockResolvedValue(false);
    const checkIsAdmin = vi.fn().mockResolvedValue(false);
    const middleware = createRequireModeratorOrAdmin(checkIsModerator, checkIsAdmin);
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(response.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() for a moderator without checking admin (short-circuit)", async () => {
    const checkIsModerator = vi.fn().mockResolvedValue(true);
    const checkIsAdmin = vi.fn();
    const middleware = createRequireModeratorOrAdmin(checkIsModerator, checkIsAdmin);
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(checkIsAdmin).not.toHaveBeenCalled();
  });

  it("calls next() for an admin who is not a moderator", async () => {
    const checkIsModerator = vi.fn().mockResolvedValue(false);
    const checkIsAdmin = vi.fn().mockResolvedValue(true);
    const middleware = createRequireModeratorOrAdmin(checkIsModerator, checkIsAdmin);
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBeUndefined();
  });
});
