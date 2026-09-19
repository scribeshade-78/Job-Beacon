import { describe, expect, it, vi } from "vitest";
import {
  listAtsCredentials,
  listAuditEvents,
  listSecurityEvents,
  setAtsCredentialActive,
  storeAtsCredential,
} from "./audit";

/**
 * Task H4. The one assertion here that is a SECURITY test rather than a wiring
 * test is the "never returns the secret" pair: the credential route is the only
 * place in the client that handles an employer API key, and a result object that
 * carried it back would put that key into component state, and from there into a
 * React tree, a screenshot and a support bundle.
 */

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe("listAuditEvents", () => {
  it("fetches with a bearer token and returns the events", async () => {
    const events = [
      {
        id: "e1",
        occurredAt: "2026-09-19T00:00:00.000Z",
        actorId: "a1",
        actorRole: "moderator",
        action: "moderation.decision.recorded",
        entityType: "moderation_case",
        entityId: "case-1",
        summary: "Recorded a moderation decision",
        reason: "Evidence supported an overturn",
        previousValues: { decision: "flagged" },
        newValues: { decision: "cleared" },
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ events }));

    const result = await listAuditEvents("tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "success", data: { events } });
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/audit-events", {
      method: "GET",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns forbidden on 401 and 403 rather than an error message", async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({ error: "nope" }) });
      expect(await listAuditEvents("tok", fetchImpl as unknown as typeof fetch)).toEqual({ kind: "forbidden" });
    }
  });

  it("returns a generic error when the server says nothing useful", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const result = await listAuditEvents("tok", fetchImpl as unknown as typeof fetch);
    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toContain("Something went wrong");
  });

  it("returns an error rather than throwing when the network fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await listAuditEvents("tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});

describe("listSecurityEvents and listAtsCredentials", () => {
  it("hit their own routes", async () => {
    const security = vi.fn().mockResolvedValue(okResponse({ events: [] }));
    await listSecurityEvents("tok", security as unknown as typeof fetch);
    expect(security).toHaveBeenCalledWith("/api/admin/security-events", expect.anything());

    const credentials = vi.fn().mockResolvedValue(okResponse({ credentials: [] }));
    await listAtsCredentials("tok", credentials as unknown as typeof fetch);
    expect(credentials).toHaveBeenCalledWith("/api/admin/ats-credentials", expect.anything());
  });
});

describe("storeAtsCredential", () => {
  it("sends the secret in the request body exactly once", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ id: "c1", sourceCode: "greenhouse", employerKey: "acme", keyHint: "9z4q" }));

    await storeAtsCredential(
      { sourceCode: "greenhouse", employerKey: "acme", secret: "gh-board-key-9z4q", label: "Acme" },
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    const [path, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0];
    expect(path).toBe("/api/admin/ats-credentials");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      sourceCode: "greenhouse",
      employerKey: "acme",
      secret: "gh-board-key-9z4q",
      label: "Acme",
    });
  });

  it("NEVER returns the secret to the caller — only the hint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ id: "c1", sourceCode: "greenhouse", employerKey: "acme", keyHint: "9z4q" }),
    );

    const result = await storeAtsCredential(
      { sourceCode: "greenhouse", employerKey: "acme", secret: "gh-board-key-9z4q" },
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.kind).toBe("success");
    expect(JSON.stringify(result)).not.toContain("gh-board-key-9z4q");
    expect(JSON.stringify(result)).toContain("9z4q");
  });

  it("surfaces the deployment reason on a 503, which names the unset variable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: "ATS credential storage is not configured on this deployment.",
        reason: "Missing ATS_CREDENTIAL_ENCRYPTION_KEY — required to encrypt/decrypt stored secrets.",
      }),
    });

    const result = await storeAtsCredential(
      { sourceCode: "lever", employerKey: "acme", secret: "k" },
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.kind).toBe("error");
    const message = (result as { message: string }).message;
    expect(message).toContain("not configured");
    expect(message).toContain("ATS_CREDENTIAL_ENCRYPTION_KEY");
  });
});

describe("setAtsCredentialActive", () => {
  it("posts the flag to the encoded id path", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ id: "c1", isActive: false, note: "Automated application is now disabled for this source." }));

    const result = await setAtsCredentialActive("c1", false, "tok", fetchImpl as unknown as typeof fetch);

    const [path, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0];
    expect(path).toBe("/api/admin/ats-credentials/c1/active");
    expect(JSON.parse(String(init.body))).toEqual({ isActive: false });
    expect(result.kind).toBe("success");
  });
});
