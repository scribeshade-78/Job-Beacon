import { describe, expect, it, vi } from "vitest";
import { listOpportunities, formatSalary, type OpportunitySalary } from "./opportunities";

/** Thenable chainable stub — select/in/eq/order all return `this`; awaiting resolves to `result`. */
function tableStub(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "in", "eq", "order"]) {
    b[m] = () => b;
  }
  b.then = (resolve: (v: unknown) => void) => resolve(result);
  return b;
}

function makeClient(
  opportunities: unknown,
  fitAnalyses: unknown = [],
  fitError: unknown = null,
) {
  return {
    from: vi.fn((table: string) => {
      if (table === "fit_analyses") {
        return tableStub({ data: fitError ? null : fitAnalyses, error: fitError });
      }
      return tableStub({ data: opportunities, error: null });
    }),
  } as never;
}

function vacancyRow(over: Record<string, unknown> = {}) {
  return {
    id: "vac-1",
    raw_title: "Test Role",
    authoritative_url: "https://example.com/jobs/1",
    company_id: null,
    country: "United Kingdom",
    region: null,
    city: "London",
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
    ...over,
  };
}

function fitRow(over: Record<string, unknown> = {}) {
  return {
    vacancy_id: "vac-1",
    technical_fit_score: 80,
    practical_eligibility_score: 100,
    eligibility_capped: false,
    hard_blockers: [],
    missing_evidence: [],
    top_reasons: [],
    jd_text_available: true,
    ...over,
  };
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

  it("attaches the fit analysis and computes the §12.1 priority score", async () => {
    const client = makeClient([vacancyRow()], [fitRow({ technical_fit_score: 80, practical_eligibility_score: 100 })]);
    const result = await listOpportunities(client);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      const fit = result.opportunities[0].fitAnalysis;
      expect(fit).not.toBeNull();
      expect(fit?.technicalFitScore).toBe(80);
      expect(fit?.practicalEligibilityScore).toBe(100);
      // 0.2*80 + 0.2*100 + 0.6*50 = 66
      expect(fit?.priority.score).toBe(66);
    }
  });

  it("leaves fitAnalysis null when there is no fit_analyses row for a vacancy", async () => {
    const client = makeClient([vacancyRow({ id: "vac-1" })], [fitRow({ vacancy_id: "vac-other" })]);
    const result = await listOpportunities(client);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.opportunities[0].fitAnalysis).toBeNull();
    }
  });

  it("sorts opportunities by priority score descending, pending ones last", async () => {
    const vacancies = [
      vacancyRow({ id: "low", authoritative_url: "https://x/low" }),
      vacancyRow({ id: "high", authoritative_url: "https://x/high" }),
      vacancyRow({ id: "pending", authoritative_url: "https://x/pending" }),
    ];
    const fits = [
      fitRow({ vacancy_id: "low", technical_fit_score: 0, practical_eligibility_score: 0 }), // 30
      fitRow({ vacancy_id: "high", technical_fit_score: 100, practical_eligibility_score: 100 }), // 70
    ];
    const client = makeClient(vacancies, fits);
    const result = await listOpportunities(client);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.opportunities.map((o) => o.id)).toEqual(["high", "low", "pending"]);
    }
  });

  it("a hard-blocked opportunity (priority 0) sorts below an eligible one but above a pending one", async () => {
    const vacancies = [
      vacancyRow({ id: "blocked", authoritative_url: "https://x/blocked" }),
      vacancyRow({ id: "eligible", authoritative_url: "https://x/eligible" }),
      vacancyRow({ id: "pending", authoritative_url: "https://x/pending" }),
    ];
    const fits = [
      fitRow({
        vacancy_id: "blocked",
        technical_fit_score: 90,
        practical_eligibility_score: 0,
        eligibility_capped: true,
        hard_blockers: [{ code: "LOCATION_PRESENCE", detail: "Not in the required country." }],
      }),
      fitRow({ vacancy_id: "eligible", technical_fit_score: 50, practical_eligibility_score: 50 }),
    ];
    const client = makeClient(vacancies, fits);
    const result = await listOpportunities(client);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.opportunities.map((o) => o.id)).toEqual(["eligible", "blocked", "pending"]);
      const blocked = result.opportunities.find((o) => o.id === "blocked")!;
      expect(blocked.fitAnalysis?.priority.score).toBe(0);
      expect(blocked.fitAnalysis?.eligibilityCapped).toBe(true);
      expect(blocked.fitAnalysis?.priority.uncappedScore).toBeGreaterThan(0);
    }
  });

  it("still returns the opportunities list when the fit_analyses query errors", async () => {
    const client = makeClient([vacancyRow()], [], { message: "fit query failed" });
    const result = await listOpportunities(client);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.opportunities).toHaveLength(1);
      expect(result.opportunities[0].fitAnalysis).toBeNull();
    }
  });
});