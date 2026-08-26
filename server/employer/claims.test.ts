import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { CompanyNotFoundError, getEmployerClaimsQueue, submitEmployerClaim, submitEmployerClaimDecision } from "./claims.js";

describe("submitEmployerClaim", () => {
  function makeClient(overrides: {
    companyResult?: { data: unknown; error: unknown };
    upsertResult?: { data: unknown; error: unknown };
  }) {
    const companySingle = vi.fn(async () => overrides.companyResult ?? { data: { domain: null }, error: null });
    const companyEq = vi.fn(() => ({ maybeSingle: companySingle }));
    const companySelect = vi.fn(() => ({ eq: companyEq }));

    const upsertSingle = vi.fn(async () => overrides.upsertResult ?? { data: { id: "claim-1" }, error: null });
    const upsertSelect = vi.fn(() => ({ single: upsertSingle }));
    const upsert = vi.fn((_payload: unknown, _options: unknown) => ({ select: upsertSelect }));

    const from = vi.fn((table: string) => {
      if (table === "companies") return { select: companySelect };
      if (table === "employer_claims") return { upsert };
      throw new Error(`Unexpected table ${table}`);
    });

    const client = { from } as unknown as SupabaseClient;
    return { client, from, upsert, companyEq };
  }

  const baseInput = {
    userId: "user-1",
    userEmail: "hr@acme.test",
    companyId: "company-1",
    representativeName: "Jane Doe",
    representativeRole: "HR Manager",
  };

  it("marks domainVerified true when the account email domain matches companies.domain", async () => {
    const { client, upsert } = makeClient({ companyResult: { data: { domain: "acme.test" }, error: null } });

    const result = await submitEmployerClaim(client, baseInput);

    expect(result).toEqual({ id: "claim-1", domainVerified: true });
    const [payload, options] = upsert.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(options).toEqual({ onConflict: "user_id,company_id" });
    expect(payload).toMatchObject({ status: "pending", domain_verified: true });
  });

  it("marks domainVerified false on a mismatched domain, but still creates a pending claim", async () => {
    const { client, upsert } = makeClient({ companyResult: { data: { domain: "acme.test" }, error: null } });

    const result = await submitEmployerClaim(client, { ...baseInput, userEmail: "someone@gmail.com" });

    expect(result).toEqual({ id: "claim-1", domainVerified: false });
    const payload = upsert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ status: "pending", domain_verified: false });
  });

  it("marks domainVerified false when companies.domain is null", async () => {
    const { client } = makeClient({ companyResult: { data: { domain: null }, error: null } });
    const result = await submitEmployerClaim(client, baseInput);
    expect(result.domainVerified).toBe(false);
  });

  it("is case-insensitive when comparing domains", async () => {
    const { client } = makeClient({ companyResult: { data: { domain: "ACME.test" }, error: null } });
    const result = await submitEmployerClaim(client, baseInput);
    expect(result.domainVerified).toBe(true);
  });

  it("throws CompanyNotFoundError when the company doesn't exist", async () => {
    const { client } = makeClient({ companyResult: { data: null, error: null } });
    await expect(submitEmployerClaim(client, baseInput)).rejects.toBeInstanceOf(CompanyNotFoundError);
  });

  it("rethrows a database error from the upsert", async () => {
    const { client } = makeClient({
      companyResult: { data: { domain: "acme.test" }, error: null },
      upsertResult: { data: null, error: new Error("db down") },
    });
    await expect(submitEmployerClaim(client, baseInput)).rejects.toThrow("db down");
  });
});

describe("getEmployerClaimsQueue", () => {
  it("maps pending claims, including the joined company name", async () => {
    const order = vi.fn(async () => ({
      data: [
        {
          id: "claim-1",
          user_id: "user-1",
          company_id: "company-1",
          representative_name: "Jane Doe",
          representative_role: "HR Manager",
          evidence: "LinkedIn: linkedin.com/in/jane",
          domain_verified: true,
          created_at: "2026-08-26T00:00:00.000Z",
          companies: { displayed_name: "Acme Corp" },
        },
      ],
      error: null,
    }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as SupabaseClient;

    const result = await getEmployerClaimsQueue(client);

    expect(result).toEqual([
      {
        id: "claim-1",
        userId: "user-1",
        companyId: "company-1",
        companyName: "Acme Corp",
        representativeName: "Jane Doe",
        representativeRole: "HR Manager",
        evidence: "LinkedIn: linkedin.com/in/jane",
        domainVerified: true,
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ]);
    expect(eq).toHaveBeenCalledWith("status", "pending");
  });

  it("throws on a database error", async () => {
    const order = vi.fn(async () => ({ data: null, error: new Error("db down") }));
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ order }) }) }));
    const client = { from } as unknown as SupabaseClient;
    await expect(getEmployerClaimsQueue(client)).rejects.toThrow("db down");
  });
});

describe("submitEmployerClaimDecision", () => {
  function makeClient(overrides: { insertResult?: { data: unknown; error: unknown }; updateResult?: { error: unknown } }) {
    const insertSingle = vi.fn(async () => overrides.insertResult ?? { data: { id: "decision-1" }, error: null });
    const insertSelect = vi.fn(() => ({ single: insertSingle }));
    const insert = vi.fn(() => ({ select: insertSelect }));

    const updateEq = vi.fn(async () => overrides.updateResult ?? { error: null });
    const update = vi.fn((_payload: unknown) => ({ eq: updateEq }));

    const from = vi.fn((table: string) => {
      if (table === "employer_claim_decisions") return { insert };
      if (table === "employer_claims") return { update };
      throw new Error(`Unexpected table ${table}`);
    });

    const client = { from } as unknown as SupabaseClient;
    return { client, insert, update, updateEq };
  }

  it("on 'verified', sets status, verified_at, and a reverification_due_at one year out", async () => {
    const { client, update } = makeClient({});

    const result = await submitEmployerClaimDecision(client, {
      claimId: "claim-1",
      reviewerId: "mod-1",
      decision: "verified",
      rationale: "Domain matched and evidence checked out.",
    });

    expect(result).toEqual({ id: "decision-1" });
    const payload = update.mock.calls[0][0] as { status: string; verified_at: string; reverification_due_at: string };
    expect(payload.status).toBe("verified");
    expect(new Date(payload.verified_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(payload.reverification_due_at).getTime()).toBeGreaterThan(Date.now() + 360 * 24 * 60 * 60 * 1000);
  });

  it("on 'rejected', clears verified_at and reverification_due_at", async () => {
    const { client, update } = makeClient({});

    await submitEmployerClaimDecision(client, {
      claimId: "claim-1",
      reviewerId: "mod-1",
      decision: "rejected",
      rationale: "No evidence of authority to represent this company.",
    });

    const payload = update.mock.calls[0][0] as { status: string; verified_at: unknown; reverification_due_at: unknown };
    expect(payload).toMatchObject({ status: "rejected", verified_at: null, reverification_due_at: null });
  });

  it("rethrows a database error from the decision insert", async () => {
    const { client } = makeClient({ insertResult: { data: null, error: new Error("db down") } });
    await expect(
      submitEmployerClaimDecision(client, { claimId: "claim-1", reviewerId: "mod-1", decision: "verified", rationale: "ok" }),
    ).rejects.toThrow("db down");
  });

  it("rethrows a database error from the employer_claims status update", async () => {
    const { client } = makeClient({ updateResult: { error: new Error("db down") } });
    await expect(
      submitEmployerClaimDecision(client, { claimId: "claim-1", reviewerId: "mod-1", decision: "verified", rationale: "ok" }),
    ).rejects.toThrow("db down");
  });
});
