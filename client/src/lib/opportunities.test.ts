import { describe, expect, it, vi } from "vitest";
import { listOpportunities, formatSalary, type OpportunitySalary } from "./opportunities";

function makeClient(opportunities: unknown) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => Promise.resolve({ data: opportunities, error: null })),
          })),
        })),
      })),
    })),
  } as never;
}

describe("formatSalary", () => {
  it("returns 'Not disclosed' when min and max are null", () => {
    const salary: OpportunitySalary = {
      min: null,
      max: null,
      currency: "GBP",
      interval: "year",
      source: "employer_disclosed",
    };
    expect(formatSalary(salary)).toBe("Not disclosed");
  });

  it("formats a range with currency and interval", () => {
    const salary: OpportunitySalary = {
      min: 45000,
      max: 55000,
      currency: "GBP",
      interval: "year",
      source: "employer_disclosed",
    };
    expect(formatSalary(salary)).toBe("GBP 45,000–55,000/year (employer disclosed)");
  });

  it("formats single value with +", () => {
    const salary: OpportunitySalary = {
      min: 50000,
      max: null,
      currency: "USD",
      interval: "year",
      source: "estimated",
    };
    expect(formatSalary(salary)).toBe("USD 50,000+/year (estimated)");
  });

  it("formats 'Up to' when only max is present", () => {
    const salary: OpportunitySalary = {
      min: null,
      max: 60000,
      currency: "EUR",
      interval: "year",
      source: "employer_disclosed",
    };
    expect(formatSalary(salary)).toBe("EUR Up to 60,000/year (employer disclosed)");
  });

  it("defaults currency to USD and interval to year when missing", () => {
    const salary: OpportunitySalary = {
      min: 40000,
      max: 50000,
      currency: null,
      interval: null,
      source: "employer_disclosed",
    };
    expect(formatSalary(salary)).toBe("USD 40,000–50,000/year (employer disclosed)");
  });
});

describe("listOpportunities", () => {
  it("returns success with mapped opportunities", async () => {
    const mockData = [
      {
        id: "vac-1",
        raw_title: "Senior Backend Engineer",
        authoritative_url: "https://example.com/jobs/1",
        company_id: "comp-1",
        country: "United Kingdom",
        region: "England",
        city: "London",
        remote_type: "hybrid",
        currency: "GBP",
        salary_min: 60000,
        salary_max: 80000,
        salary_interval: "year",
        salary_source: "employer_disclosed",
        discovered_at: "2026-01-15T10:00:00Z",
        last_seen_at: "2026-01-20T10:00:00Z",
        trust_status: "VERIFIED",
        companies: { displayed_name: "Acme Corp", domain: "acme.com" },
        vacancy_trust_scores: [{ score: 87 }],
        application_plans: [{ id: "plan-1", status: "pending", gate_results: { eligible: true } }],
      },
    ];

    const client = makeClient(mockData);
    const result = await listOpportunities(client);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.opportunities).toHaveLength(1);
      const opp = result.opportunities[0];
      expect(opp.id).toBe("vac-1");
      expect(opp.title).toBe("Senior Backend Engineer");
      expect(opp.url).toBe("https://example.com/jobs/1");
      expect(opp.companyName).toBe("Acme Corp");
      expect(opp.companyDomain).toBe("acme.com");
      expect(opp.location).toBe("London, England, United Kingdom");
      expect(opp.remoteType).toBe("hybrid");
      expect(opp.trustStatus).toBe("VERIFIED");
      expect(opp.trustScore).toBe(87);
      expect(opp.salary).toEqual({
        min: 60000,
        max: 80000,
        currency: "GBP",
        interval: "year",
        source: "employer_disclosed",
      });
      expect(opp.autoApplyStatus).toBe("queued");
    }
  });

  it("maps auto-apply status correctly for different plan states", async () => {
    const testCases = [
      { plan: null, expected: "not_started" },
      { plan: { status: "pending", gate_results: { eligible: false } }, expected: "not_started" },
      { plan: { status: "pending", gate_results: { eligible: true } }, expected: "queued" },
      { plan: { status: "in_progress", gate_results: { eligible: true } }, expected: "in_progress" },
      { plan: { status: "action_required", gate_results: { eligible: true } }, expected: "action_required" },
      { plan: { status: "completed", gate_results: { eligible: true } }, expected: "completed" },
      { plan: { status: "failed", gate_results: { eligible: true } }, expected: "failed" },
    ];

    for (const { plan, expected } of testCases) {
      const mockData = [
        {
          id: "vac-1",
          raw_title: "Test Role",
          authoritative_url: "https://example.com/jobs/1",
          company_id: null,
          country: "US",
          region: null,
          city: "San Francisco",
          remote_type: "remote",
          currency: "USD",
          salary_min: null,
          salary_max: null,
          salary_interval: null,
          salary_source: null,
          discovered_at: "2026-01-15T10:00:00Z",
          last_seen_at: "2026-01-20T10:00:00Z",
          trust_status: "VERIFIED_INCOMPLETE",
          companies: null,
          vacancy_trust_scores: [{ score: 72 }],
          application_plans: plan ? [{ id: "plan-1", ...plan }] : [],
        },
      ];

      const client = makeClient(mockData);
      const result = await listOpportunities(client);

      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.opportunities[0].autoApplyStatus).toBe(expected);
      }
    }
  });

  it("formats location correctly with partial data", async () => {
    const testCases = [
      { city: "London", region: "England", country: "United Kingdom", expected: "London, England, United Kingdom" },
      { city: "San Francisco", region: null, country: "US", expected: "San Francisco, US" },
      { city: null, region: "California", country: "US", expected: "California, US" },
      { city: null, region: null, country: "Germany", expected: "Germany" },
      { city: null, region: null, country: null, expected: "Location not specified" },
    ];

    for (const { city, region, country, expected } of testCases) {
      const mockData = [
        {
          id: "vac-1",
          raw_title: "Test Role",
          authoritative_url: "https://example.com/jobs/1",
          company_id: null,
          country,
          region,
          city,
          remote_type: null,
          currency: null,
          salary_min: null,
          salary_max: null,
          salary_interval: null,
          salary_source: null,
          discovered_at: "2026-01-15T10:00:00Z",
          last_seen_at: "2026-01-20T10:00:00Z",
          trust_status: "VERIFIED",
          companies: null,
          vacancy_trust_scores: [{ score: 72 }],
          application_plans: [],
        },
      ];

      const client = makeClient(mockData);
      const result = await listOpportunities(client);

      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.opportunities[0].location).toBe(expected);
      }
    }
  });

  it("returns error when Supabase returns error", async () => {
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(() => Promise.resolve({ data: null, error: { message: "db error" } })),
            })),
          })),
        })),
      })),
    } as never;

    const result = await listOpportunities(client);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("Could not load opportunities. Please try again.");
    }
  });

  it("returns error when Supabase throws", async () => {
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(() => Promise.reject(new Error("network error"))),
            })),
          })),
        })),
      })),
    } as never;

    const result = await listOpportunities(client);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("Could not load opportunities. Please try again.");
    }
  });

  it("filters to only VERIFIED and VERIFIED_INCOMPLETE trust statuses", async () => {
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          in: vi.fn((_col, statuses) => {
            expect(statuses).toEqual(["VERIFIED", "VERIFIED_INCOMPLETE"]);
            return {
              eq: vi.fn(() => ({
                order: vi.fn(() => Promise.resolve({ data: [], error: null })),
              })),
            };
          }),
        })),
      })),
    } as never;

    await listOpportunities(client);
  });
});