import { describe, expect, it, vi } from "vitest";
import {
  getCompanyFactCorrectionsQueue,
  listMyCompanyFactCorrections,
  submitCompanyFactCorrection,
  submitCorrectionDecision,
} from "./companyFactCorrections";

describe("listMyCompanyFactCorrections", () => {
  it("maps correction rows on success", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "correction-1",
          company_id: "company-1",
          field_name: "companies.domain",
          status: "pending",
          proposed_value: "new-domain.test",
          evidence: null,
          rationale: null,
          created_at: "2026-08-26T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listMyCompanyFactCorrections>[0];

    const result = await listMyCompanyFactCorrections(client);

    expect(result).toEqual({
      kind: "success",
      corrections: [
        {
          id: "correction-1",
          companyId: "company-1",
          fieldName: "companies.domain",
          status: "pending",
          proposedValue: "new-domain.test",
          evidence: null,
          rationale: null,
          createdAt: "2026-08-26T00:00:00.000Z",
        },
      ],
    });
    expect(from).toHaveBeenCalledWith("company_fact_corrections");
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("network down");
    });
    const client = { from } as unknown as Parameters<typeof listMyCompanyFactCorrections>[0];

    const result = await listMyCompanyFactCorrections(client);

    expect(result).toEqual({ kind: "error", message: "Could not load your fact corrections. Please try again." });
  });
});

describe("submitCompanyFactCorrection", () => {
  it("posts with a bearer token, omitting empty evidence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    const result = await submitCompanyFactCorrection(
      "company-1",
      "companies.domain",
      "new-domain.test",
      "",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "success" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/employer/companies/company-1/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ fieldName: "companies.domain", proposedValue: "new-domain.test", evidence: undefined }),
    });
  });

  it("surfaces the server's error message on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "proposedValue is required" }) });

    const result = await submitCompanyFactCorrection(
      "company-1",
      "companies.domain",
      "",
      "",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "error", message: "proposedValue is required" });
  });

  it("returns a network-error message when fetch itself throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    const result = await submitCompanyFactCorrection(
      "company-1",
      "companies.domain",
      "new-domain.test",
      "",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});

describe("getCompanyFactCorrectionsQueue", () => {
  it("fetches the queue with a bearer token and returns entries on success", async () => {
    const entries = [
      {
        id: "correction-1",
        companyId: "company-1",
        companyName: "Acme Corp",
        fieldName: "companies.domain",
        currentValue: "old-domain.test",
        proposedValue: "new-domain.test",
        evidence: null,
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => entries });

    const result = await getCompanyFactCorrectionsQueue("tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "success", entries });
    expect(fetchImpl).toHaveBeenCalledWith("/api/moderation/company-corrections", {
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns forbidden on a 403 (non-moderator)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "Forbidden" }) });
    const result = await getCompanyFactCorrectionsQueue("tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "forbidden" });
  });
});

describe("submitCorrectionDecision", () => {
  it("posts the decision with a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "correction-1" }) });

    const result = await submitCorrectionDecision(
      "correction-1",
      "approved",
      "Confirmed via DNS TXT record.",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "success" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/moderation/company-corrections/correction-1/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ decision: "approved", rationale: "Confirmed via DNS TXT record." }),
    });
  });

  it("surfaces the server's error message on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "rationale is required" }) });
    const result = await submitCorrectionDecision("correction-1", "rejected", "", "tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "error", message: "rationale is required" });
  });

  it("returns a network-error message when fetch itself throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await submitCorrectionDecision(
      "correction-1",
      "approved",
      "ok",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});
