import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  CorrectionNotFoundError,
  InvalidFieldNameError,
  InvalidProposedValueError,
  UnverifiedEmployerError,
  getCompanyFactCorrectionsQueue,
  isCorrectableField,
  submitCompanyFactCorrection,
  submitCorrectionDecision,
} from "./corrections.js";

describe("isCorrectableField", () => {
  it("accepts every field in the approved allow-list", () => {
    expect(isCorrectableField("companies.displayed_name")).toBe(true);
    expect(isCorrectableField("company_profiles.founded_year")).toBe(true);
  });

  it("rejects anything outside the allow-list", () => {
    expect(isCorrectableField("companies.id")).toBe(false);
    expect(isCorrectableField("company_profiles.operating_countries")).toBe(false);
    expect(isCorrectableField("")).toBe(false);
  });
});

describe("submitCompanyFactCorrection", () => {
  function makeClient(overrides: {
    claimResult?: { data: unknown; error: unknown };
    insertResult?: { data: unknown; error: unknown };
  }) {
    const claimSingle = vi.fn(async () => overrides.claimResult ?? { data: { id: "claim-1" }, error: null });
    const claimEqStatus = vi.fn(() => ({ maybeSingle: claimSingle }));
    const claimEqCompany = vi.fn(() => ({ eq: claimEqStatus }));
    const claimEqUser = vi.fn(() => ({ eq: claimEqCompany }));
    const claimSelect = vi.fn(() => ({ eq: claimEqUser }));

    const insertSingle = vi.fn(async () => overrides.insertResult ?? { data: { id: "correction-1" }, error: null });
    const insertSelect = vi.fn(() => ({ single: insertSingle }));
    const insert = vi.fn((_payload: unknown) => ({ select: insertSelect }));

    const from = vi.fn((table: string) => {
      if (table === "employer_claims") return { select: claimSelect };
      if (table === "company_fact_corrections") return { insert };
      throw new Error(`Unexpected table ${table}`);
    });

    const client = { from } as unknown as SupabaseClient;
    return { client, insert };
  }

  const baseInput = {
    userId: "user-1",
    companyId: "company-1",
    fieldName: "companies.domain",
    proposedValue: "acme.test",
  };

  it("throws InvalidFieldNameError for a field outside the allow-list", async () => {
    const { client } = makeClient({});
    await expect(
      submitCompanyFactCorrection(client, { ...baseInput, fieldName: "companies.id" }),
    ).rejects.toBeInstanceOf(InvalidFieldNameError);
  });

  it("throws InvalidProposedValueError when founded_year doesn't parse as an integer", async () => {
    const { client } = makeClient({});
    await expect(
      submitCompanyFactCorrection(client, {
        ...baseInput,
        fieldName: "company_profiles.founded_year",
        proposedValue: "not-a-year",
      }),
    ).rejects.toBeInstanceOf(InvalidProposedValueError);
  });

  it("throws UnverifiedEmployerError when no verified claim exists", async () => {
    const { client } = makeClient({ claimResult: { data: null, error: null } });
    await expect(submitCompanyFactCorrection(client, baseInput)).rejects.toBeInstanceOf(UnverifiedEmployerError);
  });

  it("inserts with the resolved employer_claim_id on the happy path", async () => {
    const { client, insert } = makeClient({});

    const result = await submitCompanyFactCorrection(client, baseInput);

    expect(result).toEqual({ id: "correction-1" });
    expect(insert).toHaveBeenCalledWith({
      employer_claim_id: "claim-1",
      company_id: "company-1",
      field_name: "companies.domain",
      proposed_value: "acme.test",
      evidence: null,
    });
  });

  it("accepts a valid founded_year", async () => {
    const { client } = makeClient({});
    await expect(
      submitCompanyFactCorrection(client, { ...baseInput, fieldName: "company_profiles.founded_year", proposedValue: "1999" }),
    ).resolves.toEqual({ id: "correction-1" });
  });

  it("rethrows a database error from the claim lookup", async () => {
    const { client } = makeClient({ claimResult: { data: null, error: new Error("db down") } });
    await expect(submitCompanyFactCorrection(client, baseInput)).rejects.toThrow("db down");
  });

  it("rethrows a database error from the insert", async () => {
    const { client } = makeClient({ insertResult: { data: null, error: new Error("db down") } });
    await expect(submitCompanyFactCorrection(client, baseInput)).rejects.toThrow("db down");
  });
});

describe("getCompanyFactCorrectionsQueue", () => {
  function makeClient(options: {
    corrections: unknown[];
    companies: unknown[];
    profiles: unknown[];
  }) {
    const correctionsOrder = vi.fn(async () => ({ data: options.corrections, error: null }));
    const correctionsEq = vi.fn(() => ({ order: correctionsOrder }));
    const correctionsSelect = vi.fn(() => ({ eq: correctionsEq }));

    const companiesIn = vi.fn(async () => ({ data: options.companies, error: null }));
    const companiesSelect = vi.fn(() => ({ in: companiesIn }));

    const profilesIn = vi.fn(async () => ({ data: options.profiles, error: null }));
    const profilesSelect = vi.fn(() => ({ in: profilesIn }));

    const from = vi.fn((table: string) => {
      if (table === "company_fact_corrections") return { select: correctionsSelect };
      if (table === "companies") return { select: companiesSelect };
      if (table === "company_profiles") return { select: profilesSelect };
      throw new Error(`Unexpected table ${table}`);
    });

    const client = { from } as unknown as SupabaseClient;
    return { client, companiesIn, profilesIn };
  }

  it("resolves currentValue from companies for a companies-scoped field", async () => {
    const { client } = makeClient({
      corrections: [
        {
          id: "correction-1",
          company_id: "company-1",
          field_name: "companies.domain",
          proposed_value: "new-domain.test",
          evidence: "Verified via DNS TXT record.",
          created_at: "2026-08-26T00:00:00.000Z",
          companies: { displayed_name: "Acme Corp" },
        },
      ],
      companies: [{ id: "company-1", displayed_name: "Acme Corp", domain: "old-domain.test", career_domain: null }],
      profiles: [],
    });

    const result = await getCompanyFactCorrectionsQueue(client);

    expect(result).toEqual([
      {
        id: "correction-1",
        companyId: "company-1",
        companyName: "Acme Corp",
        fieldName: "companies.domain",
        currentValue: "old-domain.test",
        proposedValue: "new-domain.test",
        evidence: "Verified via DNS TXT record.",
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ]);
  });

  it("resolves currentValue from company_profiles for a company_profiles-scoped field", async () => {
    const { client } = makeClient({
      corrections: [
        {
          id: "correction-1",
          company_id: "company-1",
          field_name: "company_profiles.founded_year",
          proposed_value: "2010",
          evidence: null,
          created_at: "2026-08-26T00:00:00.000Z",
          companies: { displayed_name: "Acme Corp" },
        },
      ],
      companies: [],
      profiles: [{ company_id: "company-1", founded_year: 2008 }],
    });

    const result = await getCompanyFactCorrectionsQueue(client);
    expect(result[0].currentValue).toBe("2008");
  });

  it("returns null currentValue when no company_profiles row exists yet", async () => {
    const { client } = makeClient({
      corrections: [
        {
          id: "correction-1",
          company_id: "company-1",
          field_name: "company_profiles.industry",
          proposed_value: "Software",
          evidence: null,
          created_at: "2026-08-26T00:00:00.000Z",
          companies: { displayed_name: "Acme Corp" },
        },
      ],
      companies: [],
      profiles: [],
    });

    const result = await getCompanyFactCorrectionsQueue(client);
    expect(result[0].currentValue).toBeNull();
  });

  it("batches the companies/company_profiles lookups once per distinct company, not per correction", async () => {
    const { client, companiesIn, profilesIn } = makeClient({
      corrections: [
        {
          id: "correction-1",
          company_id: "company-1",
          field_name: "companies.domain",
          proposed_value: "a.test",
          evidence: null,
          created_at: "2026-08-26T00:00:00.000Z",
          companies: { displayed_name: "Acme Corp" },
        },
        {
          id: "correction-2",
          company_id: "company-1",
          field_name: "companies.career_domain",
          proposed_value: "careers.a.test",
          evidence: null,
          created_at: "2026-08-26T00:01:00.000Z",
          companies: { displayed_name: "Acme Corp" },
        },
      ],
      companies: [{ id: "company-1", displayed_name: "Acme Corp", domain: "old.test", career_domain: null }],
      profiles: [],
    });

    await getCompanyFactCorrectionsQueue(client);

    expect(companiesIn).toHaveBeenCalledTimes(1);
    expect(companiesIn).toHaveBeenCalledWith("id", ["company-1"]);
    expect(profilesIn).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array with no extra queries when there are no pending corrections", async () => {
    const { client, companiesIn, profilesIn } = makeClient({ corrections: [], companies: [], profiles: [] });
    const result = await getCompanyFactCorrectionsQueue(client);
    expect(result).toEqual([]);
    expect(companiesIn).toHaveBeenCalledWith("id", []);
    expect(profilesIn).toHaveBeenCalledWith("company_id", []);
  });
});

describe("submitCorrectionDecision", () => {
  function makeClient(overrides: {
    fetchResult?: { data: unknown; error: unknown };
    companiesUpdateResult?: { error: unknown };
    profilesUpsertResult?: { error: unknown };
    decisionUpdateResult?: { error: unknown };
  }) {
    const fetchSingle = vi.fn(async () =>
      overrides.fetchResult ?? {
        data: { id: "correction-1", company_id: "company-1", field_name: "companies.domain", proposed_value: "acme.test" },
        error: null,
      },
    );
    const fetchEq = vi.fn(() => ({ maybeSingle: fetchSingle }));
    const fetchSelect = vi.fn(() => ({ eq: fetchEq }));

    const companiesUpdateEq = vi.fn(async () => overrides.companiesUpdateResult ?? { error: null });
    const companiesUpdate = vi.fn((_payload: unknown) => ({ eq: companiesUpdateEq }));

    const profilesUpsert = vi.fn(async (_payload: unknown, _options: unknown) => overrides.profilesUpsertResult ?? { error: null });

    const decisionUpdateEq = vi.fn(async () => overrides.decisionUpdateResult ?? { error: null });
    const decisionUpdate = vi.fn((_payload: unknown) => ({ eq: decisionUpdateEq }));

    let correctionsCallCount = 0;
    const from = vi.fn((table: string) => {
      if (table === "company_fact_corrections") {
        correctionsCallCount += 1;
        return correctionsCallCount === 1 ? { select: fetchSelect } : { update: decisionUpdate };
      }
      if (table === "companies") return { update: companiesUpdate };
      if (table === "company_profiles") return { upsert: profilesUpsert };
      throw new Error(`Unexpected table ${table}`);
    });

    const client = { from } as unknown as SupabaseClient;
    return { client, companiesUpdate, companiesUpdateEq, profilesUpsert, decisionUpdate, decisionUpdateEq };
  }

  const baseInput = { correctionId: "correction-1", reviewerId: "mod-1", decision: "approved" as const, rationale: "Confirmed via DNS." };

  it("on approval of a companies field, updates companies then records the decision", async () => {
    const { client, companiesUpdate, companiesUpdateEq, decisionUpdate } = makeClient({});

    const result = await submitCorrectionDecision(client, baseInput);

    expect(result).toEqual({ id: "correction-1" });
    expect(companiesUpdate).toHaveBeenCalledWith({ domain: "acme.test" });
    expect(companiesUpdateEq).toHaveBeenCalledWith("id", "company-1");
    expect(decisionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved", reviewer_id: "mod-1", rationale: "Confirmed via DNS." }),
    );
  });

  it("on approval of a company_profiles field, upserts company_profiles with onConflict company_id", async () => {
    const { client, profilesUpsert } = makeClient({
      fetchResult: {
        data: { id: "correction-1", company_id: "company-1", field_name: "company_profiles.founded_year", proposed_value: "2010" },
        error: null,
      },
    });

    await submitCorrectionDecision(client, baseInput);

    expect(profilesUpsert).toHaveBeenCalledWith({ company_id: "company-1", founded_year: 2010 }, { onConflict: "company_id" });
  });

  it("on rejection, writes no data change — only the decision", async () => {
    const { client, companiesUpdate, profilesUpsert, decisionUpdate } = makeClient({});

    await submitCorrectionDecision(client, { ...baseInput, decision: "rejected", rationale: "No evidence provided." });

    expect(companiesUpdate).not.toHaveBeenCalled();
    expect(profilesUpsert).not.toHaveBeenCalled();
    expect(decisionUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected" }));
  });

  it("throws CorrectionNotFoundError when the correction doesn't exist", async () => {
    const { client } = makeClient({ fetchResult: { data: null, error: null } });
    await expect(submitCorrectionDecision(client, baseInput)).rejects.toBeInstanceOf(CorrectionNotFoundError);
  });

  it("rethrows a database error from the companies update, without recording a decision", async () => {
    const { client, decisionUpdate } = makeClient({ companiesUpdateResult: { error: new Error("db down") } });
    await expect(submitCorrectionDecision(client, baseInput)).rejects.toThrow("db down");
    expect(decisionUpdate).not.toHaveBeenCalled();
  });

  it("rethrows a database error from the decision update", async () => {
    const { client } = makeClient({ decisionUpdateResult: { error: new Error("db down") } });
    await expect(submitCorrectionDecision(client, baseInput)).rejects.toThrow("db down");
  });
});
