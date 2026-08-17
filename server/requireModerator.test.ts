import { describe, expect, it, vi } from "vitest";
import { createRequireModerator, isModerator } from "./requireModerator.js";
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

describe("createRequireModerator", () => {
  it("returns 401 when there is no authenticated user", async () => {
    const checkIsModerator = vi.fn();
    const middleware = createRequireModerator(checkIsModerator);
    const request = {} as AuthenticatedRequest;
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(response.statusCode).toBe(401);
    expect(checkIsModerator).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when the authenticated user is not a moderator", async () => {
    const checkIsModerator = vi.fn().mockResolvedValue(false);
    const middleware = createRequireModerator(checkIsModerator);
    const request = { user: { id: "user-1", email: "a@test.local" } } as AuthenticatedRequest;
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(checkIsModerator).toHaveBeenCalledWith("user-1");
    expect(response.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when the authenticated user is a moderator", async () => {
    const checkIsModerator = vi.fn().mockResolvedValue(true);
    const middleware = createRequireModerator(checkIsModerator);
    const request = { user: { id: "user-1", email: "a@test.local" } } as AuthenticatedRequest;
    const response = makeResponse();
    const next = vi.fn();

    await middleware(request, response as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBeUndefined();
  });
});

describe("isModerator", () => {
  function makeClient(result: { data: unknown; error: unknown }) {
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => result),
    };
    return { from: vi.fn(() => builder) } as unknown as Parameters<typeof isModerator>[1];
  }

  it("returns true when a matching user_roles row exists", async () => {
    const client = makeClient({ data: { role: "moderator" }, error: null });
    await expect(isModerator("user-1", client)).resolves.toBe(true);
  });

  it("returns false when no matching row exists", async () => {
    const client = makeClient({ data: null, error: null });
    await expect(isModerator("user-1", client)).resolves.toBe(false);
  });

  it("throws when the query errors", async () => {
    const client = makeClient({ data: null, error: { message: "db error" } });
    await expect(isModerator("user-1", client)).rejects.toBeTruthy();
  });
});
