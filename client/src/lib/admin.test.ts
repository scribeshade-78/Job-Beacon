import { describe, expect, it, vi } from "vitest";
import { getAdminRoles, getAdminSourceHealth, grantAdminRole, revokeAdminRole } from "./admin";

/**
 * R8.2 role management client. The wiring assertions that matter here are the
 * route each call hits and the transport each uses: the revoke MUST be path
 * segments rather than a DELETE body, because a reverse proxy is free to strip
 * the latter and the failure would only show up in production.
 */

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe("getAdminRoles", () => {
  it("fetches with a bearer token and returns the assignment list", async () => {
    const payload = {
      assignments: [
        { userId: "u1", role: "admin", createdAt: "2026-09-01T00:00:00Z", email: "a@example.com", isSelf: true },
      ],
      truncated: false,
    };
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(payload));

    const result = await getAdminRoles("tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "success", data: payload });
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/roles", {
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns forbidden on 401 and 403 rather than an error message", async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({ error: "nope" }) });
      expect(await getAdminRoles("tok", fetchImpl as unknown as typeof fetch)).toEqual({ kind: "forbidden" });
    }
  });

  it("returns an error rather than throwing when the network fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await getAdminRoles("tok", fetchImpl as unknown as typeof fetch)).toEqual({
      kind: "error",
      message: "Network error contacting the server.",
    });
  });
});

describe("grantAdminRole", () => {
  it("posts the email and role and returns the grant result", async () => {
    const payload = { userId: "u1", email: "a@example.com", role: "admin", alreadyHeld: false };
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(payload));

    const result = await grantAdminRole("a@example.com", "admin", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "success", data: payload });
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ email: "a@example.com", role: "admin" }),
    });
  });

  it("surfaces the server reason for a 404 so the failing address is visible", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "No registered user with that email address." }),
    });

    const result = await grantAdminRole("nobody@example.com", "admin", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "error", message: "No registered user with that email address." });
  });

  it("falls back to a generic message when the server says nothing useful", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const result = await grantAdminRole("a@example.com", "moderator", "tok", fetchImpl as unknown as typeof fetch);

    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toContain("Something went wrong");
  });
});

describe("revokeAdminRole", () => {
  it("deletes by path segments, with no request body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ userId: "u1", role: "admin", removed: true }));

    const result = await revokeAdminRole("u1", "admin", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "success", data: { userId: "u1", role: "admin", removed: true } });
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/roles/u1/admin", {
      method: "DELETE",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("encodes both path segments, so a malformed id cannot forge a route", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ userId: "u1", role: "moderator", removed: false }));

    await revokeAdminRole("a/b", "moderator", "tok", fetchImpl as unknown as typeof fetch);

    const [path] = (fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0];
    expect(path).toBe("/api/admin/roles/a%2Fb/moderator");
  });

  it("surfaces the self-lockout refusal verbatim", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "You cannot revoke your own admin role." }),
    });

    const result = await revokeAdminRole("u1", "admin", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "error", message: "You cannot revoke your own admin role." });
  });

  it("returns forbidden on 403", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "Forbidden" }) });

    expect(await revokeAdminRole("u1", "admin", "tok", fetchImpl as unknown as typeof fetch)).toEqual({
      kind: "forbidden",
    });
  });
});

describe("getAdminSourceHealth", () => {
  it("builds the filter query string and returns the window", async () => {
    const payload = { events: [], sources: [], limit: 50, truncated: false };
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(payload));

    const result = await getAdminSourceHealth(
      { limit: 50, sourceCode: "jooble", status: "error" },
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "success", data: payload });
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/source-health?limit=50&sourceCode=jooble&status=error", {
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("omits the query string entirely when no filter is set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ events: [], sources: [], limit: 100, truncated: false }));

    await getAdminSourceHealth({}, "tok", fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/source-health", {
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("encodes the source code rather than splicing it into the URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ events: [], sources: [], limit: 100, truncated: false }));

    await getAdminSourceHealth({ sourceCode: "a&b=c" }, "tok", fetchImpl as unknown as typeof fetch);

    const [path] = (fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0];
    expect(path).toBe("/api/admin/source-health?sourceCode=a%26b%3Dc");
  });

  it("returns forbidden on 403", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "Forbidden" }) });

    expect(await getAdminSourceHealth({}, "tok", fetchImpl as unknown as typeof fetch)).toEqual({ kind: "forbidden" });
  });
});
