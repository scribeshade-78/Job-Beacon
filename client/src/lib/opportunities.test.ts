import { describe, expect, it, vi } from "vitest";
import {
  listOpportunities,
  formatSalary,
  OPPORTUNITIES_PAGE_SIZE,
  type OpportunitySalary,
} from "./opportunities";
import {
  computePriorityScore,
  PRIORITY_SCORE_VERSION,
  type PriorityScoreInput,
} from "../../../shared/priorityScore";

interface Recorded {
  table?: string;
  columns?: string;
  orders: Array<[string, unknown]>;
  nots: Array<[string, string, unknown]>;
  range?: [number, number];
}

/**
 * Records the query the lib builds against candidate_opportunities and
 * resolves to `result`. order() is chained twice, then range().
 */
function makeClient(result: { data: unknown; error?: unknown }) {
  const recorded: Recorded = { orders: [], nots: [] };

  const builder: Record<string, unknown> = {
    select: (columns: string) => {
      recorded.columns = columns;
      return builder;
    },
    not: (column: string, operator: string, value: unknown) => {
      recorded.nots.push([column, operator, value]);
      return builder;
    },
    order: (column: string, opts: unknown) => {
      recorded.orders.push([column, opts]);
      return builder;
    },
    range: (from: number, to: number) => {
      recorded.range = [from, to];
      return builder;
    },
    then: (resolve: (v: unknown) => void) => resolve({ error: null, ...result }),
  };

  const client = {
    from: vi.fn((table: string) => {
      recorded.table = table;
      return builder;
    }),
  } as never;

  return { client, recorded };
}

/** One candidate_opportunities row with no fit analysis attached. */
function viewRow(over: Record<string, unknown> = {}) {
  return {
    id: "vac-1",
    raw_title: "Senior Backend Engineer",
    authoritative_url: "https://example.com/jobs/1",
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
    expires_at: null,
    trust_status: "VERIFIED",
    company_name: "Acme Corp",
    company_domain: "acme.com",
    plan_gate_results: null,
    attempt_status: null,
    // A NULL jd_text_available is how the LEFT JOIN reports "no fit row".
    technical_fit_score: null,
    practical_eligibility_score: null,
    eligibility_capped: null,
    hard_blockers: null,
    missing_evidence: null,
    top_reasons: null,
    jd_text_available: null,
    priority_score: null,
    priority_uncapped_score: null,
    priority_components: null,
    priority_score_version: null,
    ...over,
  };
}

/** A view row carrying a stored score, as analyzeFit would have written it. */
function scoredRow(input: PriorityScoreInput, over: Record<string, unknown> = {}) {
  const p = computePriorityScore(input);
  return viewRow({
    technical_fit_score: input.technicalFitScore,
    practical_eligibility_score: input.practicalEligibilityScore,
    eligibility_capped: input.eligibilityCapped,
    hard_blockers: [],
    missing_evidence: [],
    top_reasons: [],
    jd_text_available: true,
    priority_score: p.score,
    priority_uncapped_score: p.uncappedScore,
    priority_components: p.components,
    priority_score_version: PRIORITY_SCORE_VERSION,
    ...over,
  });
}

const STORED_INPUT: PriorityScoreInput = {
  technicalFitScore: 80,
  practicalEligibilityScore: 100,
  eligibilityCapped: false,
  responseCategory: "interview",
  companyCredibility: 90,
  remoteType: "remote",
  deadlineDays: null, // snapshot urgency neutral
};

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

describe("listOpportunities — query shape", () => {
  it("reads the candidate_opportunities view, not the vacancies table", async () => {
    const { client, recorded } = makeClient({ data: [] });
    await listOpportunities(client);

    expect(recorded.table).toBe("candidate_opportunities");
  });

  it("orders by the stored priority_score descending, nulls last, then last_seen_at", async () => {
    const { client, recorded } = makeClient({ data: [] });
    await listOpportunities(client);

    expect(recorded.orders[0]).toEqual(["priority_score", { ascending: false, nullsFirst: false }]);
    // Task I moved the ordering into shared/opportunityQuery.ts, which declares
    // nullsFirst on EVERY clause rather than only on the one whose column is
    // nullable. The tiebreak therefore now states nullsFirst: false explicitly
    // where it previously inherited Postgres's default — which differs between
    // ASC and DESC, and relying on it is how a descending sort silently puts
    // nulls first. The assertion stays exact; only the expected shape changed.
    expect(recorded.orders[1]).toEqual(["last_seen_at", { ascending: false, nullsFirst: false }]);
  });

  it("requests the default page when no options are given", async () => {
    const { client, recorded } = makeClient({ data: [] });
    await listOpportunities(client);

    expect(recorded.range).toEqual([0, OPPORTUNITIES_PAGE_SIZE - 1]);
  });

  it("translates offset/limit into an inclusive range", async () => {
    const { client, recorded } = makeClient({ data: [] });
    await listOpportunities(client, { offset: 25, limit: 10 });

    expect(recorded.range).toEqual([25, 34]);
  });

  it("does not filter on trust_status or status — the view already does", async () => {
    const { client, recorded } = makeClient({ data: [] });
    await listOpportunities(client);

    // The view's WHERE owns this; a client-side filter would duplicate it.
    expect(recorded.columns).not.toContain("status=");
  });

  it("excludes the [MOCK] local-fixture postings in SQL, before paging", async () => {
    const { client, recorded } = makeClient({ data: [] });
    await listOpportunities(client);

    // Excluded in the query rather than after the fetch, so a page still
    // returns a full page of real rows instead of a short one.
    expect(recorded.nots).toContainEqual(["source_code", "eq", "local_fixture"]);
  });
});

describe("listOpportunities — mapping", () => {
  it("maps view columns onto an OpportunitySummary", async () => {
    const { client } = makeClient({ data: [viewRow()] });
    const result = await listOpportunities(client);

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const opp = result.opportunities[0];
    expect(opp.id).toBe("vac-1");
    expect(opp.title).toBe("Senior Backend Engineer");
    expect(opp.url).toBe("https://example.com/jobs/1");
    expect(opp.companyName).toBe("Acme Corp");
    expect(opp.companyDomain).toBe("acme.com");
    expect(opp.location).toBe("London, England, United Kingdom");
    expect(opp.remoteType).toBe("hybrid");
    expect(opp.trustStatus).toBe("VERIFIED");
    expect(opp.salary).toEqual({
      min: 60000,
      max: 80000,
      currency: "GBP",
      interval: "year",
      source: "employer_disclosed",
    });
    expect(opp.autoApplyStatus).toBe("not_started");
    expect(opp.fitAnalysis).toBeNull();
  });

  it("handles a vacancy with no company row (LEFT JOIN)", async () => {
    const { client } = makeClient({ data: [viewRow({ company_name: null, company_domain: null })] });
    const result = await listOpportunities(client);

    if (result.kind !== "success") throw new Error("expected success");
    expect(result.opportunities[0].companyName).toBeNull();
    expect(result.opportunities[0].companyDomain).toBeNull();
  });

  it("formats location correctly with partial data", async () => {
    const cases = [
      { city: "London", region: "England", country: "United Kingdom", expected: "London, England, United Kingdom" },
      { city: "San Francisco", region: null, country: "US", expected: "San Francisco, US" },
      { city: null, region: "California", country: "US", expected: "California, US" },
      { city: null, region: null, country: "Germany", expected: "Germany" },
      { city: null, region: null, country: null, expected: "Location not specified" },
    ];

    for (const { city, region, country, expected } of cases) {
      const { client } = makeClient({ data: [viewRow({ city, region, country })] });
      const result = await listOpportunities(client);

      if (result.kind !== "success") throw new Error("expected success");
      expect(result.opportunities[0].location).toBe(expected);
    }
  });

  // Every case below is a real application_attempts.status value from the
  // table's CHECK constraint: pending / leased / succeeded / failed /
  // action_required / cancelled.
  it("maps auto-apply status from the latest attempt status", async () => {
    const eligible = { eligible: true };
    const cases = [
      { attempt_status: null, plan_gate_results: null, expected: "not_started" },
      { attempt_status: null, plan_gate_results: eligible, expected: "not_started" },
      { attempt_status: "pending", plan_gate_results: { eligible: false }, expected: "not_started" },
      { attempt_status: "pending", plan_gate_results: eligible, expected: "queued" },
      { attempt_status: "leased", plan_gate_results: eligible, expected: "in_progress" },
      { attempt_status: "action_required", plan_gate_results: eligible, expected: "action_required" },
      { attempt_status: "succeeded", plan_gate_results: eligible, expected: "completed" },
      { attempt_status: "failed", plan_gate_results: eligible, expected: "failed" },
      { attempt_status: "cancelled", plan_gate_results: eligible, expected: "failed" },
      { attempt_status: "status_added_later", plan_gate_results: eligible, expected: "not_started" },
    ];

    for (const { attempt_status, plan_gate_results, expected } of cases) {
      const { client } = makeClient({ data: [viewRow({ attempt_status, plan_gate_results })] });
      const result = await listOpportunities(client);

      if (result.kind !== "success") throw new Error("expected success");
      expect(result.opportunities[0].autoApplyStatus).toBe(expected);
    }
  });

  it("leaves fitAnalysis null when the view found no fit row", async () => {
    const { client } = makeClient({ data: [viewRow()] });
    const result = await listOpportunities(client);

    if (result.kind !== "success") throw new Error("expected success");
    expect(result.opportunities[0].fitAnalysis).toBeNull();
  });

  it("builds the fit analysis when the view carries one", async () => {
    const { client } = makeClient({
      data: [scoredRow(STORED_INPUT, { hard_blockers: [], top_reasons: ["Strong Go match"], missing_evidence: ["Terraform"] })],
    });
    const result = await listOpportunities(client);

    if (result.kind !== "success") throw new Error("expected success");
    const fit = result.opportunities[0].fitAnalysis;
    expect(fit).not.toBeNull();
    expect(fit?.technicalFitScore).toBe(80);
    expect(fit?.practicalEligibilityScore).toBe(100);
    expect(fit?.topReasons).toEqual(["Strong Go match"]);
    expect(fit?.missingEvidence).toEqual(["Terraform"]);
    expect(fit?.jdTextAvailable).toBe(true);
  });
});

describe("listOpportunities — priority score", () => {
  async function priorityOf(row: unknown) {
    const { client } = makeClient({ data: [row] });
    const result = await listOpportunities(client);
    if (result.kind !== "success") throw new Error("expected success");
    return result.opportunities[0].fitAnalysis!.priority;
  }

  it("reads the stored score rather than recomputing from the fit fields", async () => {
    const stored = computePriorityScore(STORED_INPUT);
    const p = await priorityOf(scoredRow(STORED_INPUT));

    expect(p.version).toBe(PRIORITY_SCORE_VERSION);
    expect(p.score).toBe(stored.score);
    expect(p.score).not.toBe(66); // what the 2.3a fallback would produce
    expect(p.components?.company_credibility).toEqual({ weight: 0.05, value: 90, source: "fit" });
  });

  it("refreshes the urgency slice from the row's current expires_at", async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const p = await priorityOf(scoredRow(STORED_INPUT, { expires_at: soon }));

    expect(p.score).toBe(computePriorityScore({ ...STORED_INPUT, deadlineDays: 1 }).score);
    expect(p.score).toBeGreaterThan(computePriorityScore(STORED_INPUT).score!);
  });

  it("a past expires_at leaves urgency neutral", async () => {
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const p = await priorityOf(scoredRow(STORED_INPUT, { expires_at: past }));

    expect(p.score).toBe(computePriorityScore(STORED_INPUT).score);
  });

  it("a hard-blocked row reports score 0 with a positive uncapped score", async () => {
    const capped: PriorityScoreInput = { ...STORED_INPUT, practicalEligibilityScore: 0, eligibilityCapped: true };
    const p = await priorityOf(scoredRow(capped));

    expect(p.score).toBe(0);
    expect(p.capped).toBe(true);
    expect(p.uncappedScore).toBeGreaterThan(0);
  });

  it("falls back to the 2.3a computation for a row the reconcile pass has not reached", async () => {
    const p = await priorityOf(
      viewRow({
        technical_fit_score: 80,
        practical_eligibility_score: 100,
        eligibility_capped: false,
        jd_text_available: true,
      }),
    );

    expect(p.version).toBe(PRIORITY_SCORE_VERSION);
    expect(p.score).toBe(66); // 0.2*80 + 0.2*100 + 0.6*50
    expect(p.components?.company_credibility.source).toBe("neutral");
  });

  it("falls back when the stored breakdown was written under an older version", async () => {
    const p = await priorityOf(scoredRow(STORED_INPUT, { priority_score_version: "priority-v2" }));

    expect(p.score).toBe(66);
    expect(p.components?.response_stage.source).toBe("neutral");
  });
});

describe("listOpportunities — page-local ordering", () => {
  it("re-sorts the page by the urgency-refreshed score", async () => {
    const soon = new Date(Date.now() + 1 * 86_400_000).toISOString();

    // SQL returned these in stored-score order (both snapshots are equal),
    // but only the second has a live deadline, so it must rank first.
    const flat = scoredRow(STORED_INPUT, { id: "flat", last_seen_at: "2026-01-20T10:00:00Z" });
    const urgent = scoredRow(STORED_INPUT, {
      id: "urgent",
      expires_at: soon,
      last_seen_at: "2026-01-19T10:00:00Z",
    });

    const { client } = makeClient({ data: [flat, urgent] });
    const result = await listOpportunities(client);

    if (result.kind !== "success") throw new Error("expected success");
    expect(result.opportunities.map((o) => o.id)).toEqual(["urgent", "flat"]);
  });

  it("puts un-analysed opportunities last and hard-blocked ones in between", async () => {
    const eligible = scoredRow(
      { technicalFitScore: 50, practicalEligibilityScore: 50, eligibilityCapped: false },
      { id: "eligible" },
    );
    const blocked = scoredRow(
      { technicalFitScore: 90, practicalEligibilityScore: 0, eligibilityCapped: true },
      { id: "blocked" },
    );
    const pending = viewRow({ id: "pending" });

    const { client } = makeClient({ data: [pending, blocked, eligible] });
    const result = await listOpportunities(client);

    if (result.kind !== "success") throw new Error("expected success");
    expect(result.opportunities.map((o) => o.id)).toEqual(["eligible", "blocked", "pending"]);
  });
});

describe("listOpportunities — pagination", () => {
  it("reports hasMore when the page came back full", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => viewRow({ id: `vac-${i}` }));
    const { client } = makeClient({ data: rows });

    const result = await listOpportunities(client, { limit: 3 });

    if (result.kind !== "success") throw new Error("expected success");
    expect(result.hasMore).toBe(true);
  });

  it("reports hasMore false on a short page", async () => {
    const rows = Array.from({ length: 2 }, (_, i) => viewRow({ id: `vac-${i}` }));
    const { client } = makeClient({ data: rows });

    const result = await listOpportunities(client, { limit: 3 });

    if (result.kind !== "success") throw new Error("expected success");
    expect(result.hasMore).toBe(false);
  });

  it("reports hasMore false on an empty page", async () => {
    const { client } = makeClient({ data: [] });
    const result = await listOpportunities(client, { limit: 3 });

    if (result.kind !== "success") throw new Error("expected success");
    expect(result.opportunities).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});

describe("listOpportunities — failures", () => {
  it("returns the generic message when the view query errors", async () => {
    const { client } = makeClient({ data: null, error: { message: "db error" } });
    const result = await listOpportunities(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("Could not load opportunities. Please try again.");
    }
  });

  it("returns the generic message when the query throws", async () => {
    const client = {
      from: vi.fn(() => ({
        select: () => ({
          order: () => ({
            order: () => ({
              range: () => Promise.reject(new Error("network error")),
            }),
          }),
        }),
      })),
    } as never;

    const result = await listOpportunities(client);
    expect(result.kind).toBe("error");
  });
});

describe("Task I — the locally refreshed priority order is confined to best match", () => {
  /**
   * The bug this pins: listOpportunities re-sorted every page by the
   * urgency-refreshed priority score. That is correct for best match and wrong
   * for every other sort — SQL selected the page in the requested order and the
   * local re-sort then scrambled it, while the panel still labelled it sorted.
   *
   * A non-priority sort is therefore asserted by giving the client rows whose
   * SQL order is the REVERSE of their priority order, and requiring that order
   * to survive.
   */
  const priorityDescending = [
    viewRow({ id: "row-high-priority", priority_score: 90 }),
    viewRow({ id: "row-low-priority", priority_score: 10 }),
  ];
  const priorityAscending = [priorityDescending[1], priorityDescending[0]];

  function idsOf(result: Awaited<ReturnType<typeof listOpportunities>>): string[] {
    return (result as { opportunities: Array<{ id: string }> }).opportunities.map((entry) => entry.id);
  }

  it("preserves SQL's order for the newest sort", async () => {
    const { client } = makeClient({ data: priorityAscending });

    expect(idsOf(await listOpportunities(client, { sort: "newest" }))).toEqual([
      "row-low-priority",
      "row-high-priority",
    ]);
  });

  it("preserves SQL's order for the highest salary sort", async () => {
    const { client } = makeClient({ data: priorityAscending });

    expect(idsOf(await listOpportunities(client, { sort: "highest_salary" }))).toEqual([
      "row-low-priority",
      "row-high-priority",
    ]);
  });

  // The best-match re-sort itself is NOT re-asserted here. Rows without a fit
  // analysis carry no refreshed score, so two such rows tie and the local sort
  // is a no-op that would make a test pass for the wrong reason; the existing
  // page-local ordering tests, which build real scored rows via scoredRow(),
  // already cover it. What this block pins is the new boundary: the re-sort must
  // not touch the other sorts.
});

