import { describe, expect, it, vi } from "vitest";
import { getModerationQueue, submitModerationDecision, MODERATION_POLICY_VERSION } from "./moderation";

describe("getModerationQueue", () => {
  it("fetches the queue with a bearer token and returns the entries on success", async () => {
    const entries = [
      {
        caseId: "case-1",
        vacancyId: "vacancy-1",
        vacancyTitle: "Backend Engineer",
        vacancyUrl: "https://example.com/jobs/1",
        sourceType: "rule",
        severity: "critical",
        evidenceSnapshot: { reasonCodes: ["PAYMENT_REQUEST"] },
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => entries });

    const result = await getModerationQueue("tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "success", entries });
    expect(fetchImpl).toHaveBeenCalledWith("/api/moderation/queue", {
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns forbidden on a 403 (non-moderator)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "Forbidden" }) });

    const result = await getModerationQueue("tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "forbidden" });
  });

  it("returns forbidden on a 401 (unauthenticated)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) });

    const result = await getModerationQueue("tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "forbidden" });
  });

  it("returns a generic error on a non-ok, non-auth response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "boom" }) });

    const result = await getModerationQueue("tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "error", message: "Could not load the moderation queue. Please try again." });
  });

  it("returns a network-error message when fetch itself throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    const result = await getModerationQueue("tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});

describe("submitModerationDecision", () => {
  it("posts the decision with the fixed policy version and a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "decision-1" }) });

    const result = await submitModerationDecision(
      "case-1",
      "blocked",
      "Confirmed scam pattern.",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "success" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/moderation/cases/case-1/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({
        decision: "blocked",
        rationale: "Confirmed scam pattern.",
        policyVersion: MODERATION_POLICY_VERSION,
      }),
    });
  });

  it("includes appealId in the body when resolving an appeal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "decision-1" }) });

    await submitModerationDecision(
      "case-1",
      "cleared",
      "Domain check was a false positive.",
      "tok",
      fetchImpl as unknown as typeof fetch,
      "appeal-1",
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/moderation/cases/case-1/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({
        decision: "cleared",
        rationale: "Domain check was a false positive.",
        policyVersion: MODERATION_POLICY_VERSION,
        appealId: "appeal-1",
      }),
    });
  });

  it("surfaces the server's error message on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "rationale is required" }) });

    const result = await submitModerationDecision("case-1", "cleared", "", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "error", message: "rationale is required" });
  });

  it("surfaces the reviewer-separation 409 message", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({ error: "Reviewer separation violation" }) });

    const result = await submitModerationDecision(
      "case-1",
      "escalated",
      "Appeal review.",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "error", message: "Reviewer separation violation" });
  });

  it("falls back to a generic message when the error body isn't usable JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error("not json");
      },
    });

    const result = await submitModerationDecision(
      "case-1",
      "flagged",
      "Needs another look.",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "error", message: "Could not record this decision. Please try again." });
  });

  it("returns a network-error message when fetch itself throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    const result = await submitModerationDecision(
      "case-1",
      "request_info",
      "Need more evidence.",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});
