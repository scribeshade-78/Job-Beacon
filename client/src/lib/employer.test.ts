import { describe, expect, it, vi } from "vitest";
import {
  getEmployerClaimsQueue,
  listMyEmployerClaims,
  submitEmployerClaim,
  submitEmployerClaimDecision,
} from "./employer";

describe("listMyEmployerClaims", () => {
  it("maps claim rows on success", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "claim-1",
          company_id: "company-1",
          status: "pending",
          representative_name: "Jane Doe",
          representative_role: "HR Manager",
          evidence: null,
          domain_verified: true,
          verified_at: null,
          created_at: "2026-08-26T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listMyEmployerClaims>[0];

    const result = await listMyEmployerClaims(client);

    expect(result).toEqual({
      kind: "success",
      claims: [
        {
          id: "claim-1",
          companyId: "company-1",
          status: "pending",
          representativeName: "Jane Doe",
          representativeRole: "HR Manager",
          evidence: null,
          domainVerified: true,
          verifiedAt: null,
          createdAt: "2026-08-26T00:00:00.000Z",
        },
      ],
    });
    expect(from).toHaveBeenCalledWith("employer_claims");
  });

  it("returns an empty list when the candidate has no employer claims", async () => {
    const order = vi.fn().mockResolvedValue({ data: [], error: null });
    const from = vi.fn(() => ({ select: () => ({ order }) }));
    const client = { from } as unknown as Parameters<typeof listMyEmployerClaims>[0];

    const result = await listMyEmployerClaims(client);

    expect(result).toEqual({ kind: "success", claims: [] });
  });

  it("returns a generic error on failure", async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const from = vi.fn(() => ({ select: () => ({ order }) }));
    const client = { from } as unknown as Parameters<typeof listMyEmployerClaims>[0];

    const result = await listMyEmployerClaims(client);

    expect(result.kind).toBe("error");
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("network down");
    });
    const client = { from } as unknown as Parameters<typeof listMyEmployerClaims>[0];

    const result = await listMyEmployerClaims(client);

    expect(result).toEqual({ kind: "error", message: "Could not load your employer claims. Please try again." });
  });
});

describe("submitEmployerClaim", () => {
  it("posts with a bearer token, omitting empty evidence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    const result = await submitEmployerClaim(
      "company-1",
      "Jane Doe",
      "HR Manager",
      "",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "success" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/employer/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({
        companyId: "company-1",
        representativeName: "Jane Doe",
        representativeRole: "HR Manager",
        evidence: undefined,
      }),
    });
  });

  it("surfaces the server's error message on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "companyId is required" }) });

    const result = await submitEmployerClaim("", "Jane Doe", "HR Manager", "", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "error", message: "companyId is required" });
  });

  it("returns a network-error message when fetch itself throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    const result = await submitEmployerClaim(
      "company-1",
      "Jane Doe",
      "HR Manager",
      "",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});

describe("getEmployerClaimsQueue", () => {
  it("fetches the queue with a bearer token and returns entries on success", async () => {
    const entries = [
      {
        id: "claim-1",
        userId: "user-1",
        companyId: "company-1",
        companyName: "Acme Corp",
        representativeName: "Jane Doe",
        representativeRole: "HR Manager",
        evidence: null,
        domainVerified: true,
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => entries });

    const result = await getEmployerClaimsQueue("tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "success", entries });
    expect(fetchImpl).toHaveBeenCalledWith("/api/moderation/employer-claims", {
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns forbidden on a 403 (non-moderator)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "Forbidden" }) });
    const result = await getEmployerClaimsQueue("tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "forbidden" });
  });

  it("returns a network-error message when fetch itself throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await getEmployerClaimsQueue("tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});

describe("submitEmployerClaimDecision", () => {
  it("posts the decision with a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "decision-1" }) });

    const result = await submitEmployerClaimDecision(
      "claim-1",
      "verified",
      "Domain matched.",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "success" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/moderation/employer-claims/claim-1/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ decision: "verified", rationale: "Domain matched." }),
    });
  });

  it("surfaces the server's error message on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "rationale is required" }) });
    const result = await submitEmployerClaimDecision("claim-1", "rejected", "", "tok", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ kind: "error", message: "rationale is required" });
  });

  it("falls back to a generic message when the error body isn't usable JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error("not json");
      },
    });

    const result = await submitEmployerClaimDecision(
      "claim-1",
      "rejected",
      "No evidence.",
      "tok",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ kind: "error", message: "Could not record this decision. Please try again." });
  });
});
