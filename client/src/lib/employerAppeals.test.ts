import { describe, expect, it, vi } from "vitest";
import { getAppealsQueue, listBlockedVacancies, submitVacancyAppeal } from "./employerAppeals";

describe("listBlockedVacancies", () => {
  it("fetches the company's blocked vacancies with a bearer token", async () => {
    const entries = [
      {
        vacancyId: "vacancy-1",
        title: "Backend Engineer",
        url: "https://x.test/1",
        decisionId: "decision-1",
        decisionRationale: "Scam pattern.",
        decisionPolicyVersion: "v1",
        decisionCreatedAt: "2026-08-20T00:00:00.000Z",
        hasPendingAppeal: false,
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => entries });

    const result = await listBlockedVacancies("company-1", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "success", entries });
    expect(fetchImpl).toHaveBeenCalledWith("/api/employer/companies/company-1/blocked-vacancies", {
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns forbidden on a 403 (not a verified employer for this company)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "Forbidden" }) });
    const result = await listBlockedVacancies("company-1", "tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "forbidden" });
  });

  it("returns a network-error message when fetch itself throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await listBlockedVacancies("company-1", "tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});

describe("submitVacancyAppeal", () => {
  it("posts with a bearer token, omitting empty evidence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    const result = await submitVacancyAppeal(
      "company-1",
      "vacancy-1",
      "False positive.",
      "",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "success" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/employer/appeals", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ companyId: "company-1", vacancyId: "vacancy-1", rationale: "False positive.", evidence: undefined }),
    });
  });

  it("surfaces the server's error message on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "An appeal for this vacancy is already pending." }) });

    const result = await submitVacancyAppeal("company-1", "vacancy-1", "x", "", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "error", message: "An appeal for this vacancy is already pending." });
  });

  it("returns a network-error message when fetch itself throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await submitVacancyAppeal("company-1", "vacancy-1", "x", "", "tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});

describe("getAppealsQueue", () => {
  it("fetches the queue with a bearer token and returns entries on success", async () => {
    const entries = [
      {
        caseId: "case-1",
        appealId: "appeal-1",
        vacancyId: "vacancy-1",
        vacancyTitle: "Backend Engineer",
        vacancyUrl: "https://x.test/1",
        appealRationale: "False positive.",
        appealEvidence: null,
        evidenceDeadline: "2026-09-02T00:00:00.000Z",
        originalDecisionId: "decision-1",
        originalDecisionRationale: "Confirmed scam pattern.",
        originalDecisionPolicyVersion: "v1",
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => entries });

    const result = await getAppealsQueue("tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "success", entries });
    expect(fetchImpl).toHaveBeenCalledWith("/api/moderation/appeals", {
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns forbidden on a 403 (non-moderator)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "Forbidden" }) });
    const result = await getAppealsQueue("tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "forbidden" });
  });
});
