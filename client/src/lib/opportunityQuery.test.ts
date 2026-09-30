import { describe, expect, it } from "vitest";
import {
  VACANCY_FILTERS,
  VACANCY_SORTS,
  isFilterAvailable,
  isSortAvailable,
} from "../../../shared/opportunityQuery";
import {
  EMPTY_FILTERS,
  applyOpportunityFilters,
  applyOpportunitySort,
  applyPreferenceExclusions,
  applySearchPreferenceConstraints,
  countActiveFilters,
  deriveFiltersFromPreferences,
  evaluateSearchPreferenceEligibility,
  filterOpportunitiesByRoleRelevance,
  freshnessCutoff,
  inheritedFilterLabels,
  type FilterableQuery,
  type OpportunityFilters,
  type SearchPreferenceJob,
} from "./opportunityQuery";
import { buildSearchPreferences, type SearchPreferences } from "../../../shared/searchPreferences";
import { ineligibilityReasonOf } from "../../../shared/eligibilityReason";
import { EMPTY_PREFERENCES, type CandidatePreferences } from "./candidatePreferences";

/**
 * A recording double. The value of these tests is asserting WHICH PostgREST
 * clauses are emitted, because the failure mode a filter bar has is not a crash
 * — it is a filter that quietly matches everything.
 */
function recorder() {
  const calls: string[] = [];
  const query: FilterableQuery = {
    in: (column, values) => { calls.push("in:" + column + "=" + values.join("|")); return query; },
    eq: (column, value) => { calls.push("eq:" + column + "=" + String(value)); return query; },
    gte: (column, value) => { calls.push("gte:" + column + "=" + String(value)); return query; },
    is: (column, value) => { calls.push("is:" + column + "=" + String(value)); return query; },
    or: (filter) => { calls.push("or:" + filter); return query; },
    not: (column, operator, value) => { calls.push("not:" + column + "." + operator + "." + String(value)); return query; },
    order: (column, options) => { calls.push("order:" + column + ":" + (options?.ascending === false ? "desc" : "asc")); return query; },
  };
  return { query, calls };
}

function filters(overrides: Partial<OpportunityFilters> = {}): OpportunityFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

describe("the shared spec is self-consistent", () => {
  it("declares all 10 filters and 6 sorts", () => {
    expect(VACANCY_FILTERS).toHaveLength(10);
    expect(VACANCY_SORTS).toHaveLength(6);
  });

  it("gives every unavailable field a reason, so the UI can always explain itself", () => {
    for (const spec of [...VACANCY_FILTERS, ...VACANCY_SORTS]) {
      const available = "columns" in spec ? spec.columns.length > 0 : spec.orderBy.length > 0;
      const reason = "unavailableReason" in spec ? spec.unavailableReason : null;

      if (available) {
        expect(reason).toBeNull();
      } else {
        // An unavailable control with no reason is the misleading state Task F
        // removed: it looks like a choice that does nothing.
        expect(typeof reason).toBe("string");
        expect((reason as string).length).toBeGreaterThan(20);
      }
    }
  });

  it("reports employment type and seniority as unavailable, and nothing else", () => {
    const unavailable = VACANCY_FILTERS.filter((spec) => !isFilterAvailable(spec.id)).map((spec) => spec.id);
    expect(unavailable).toEqual(["employment_type", "seniority"]);
  });

  it("reports the three unbacked sorts as unavailable", () => {
    const unavailable = VACANCY_SORTS.filter((spec) => !isSortAvailable(spec.id)).map((spec) => spec.id);
    expect(unavailable).toEqual(["company_rating", "work_life_balance", "recently_verified"]);
  });
});

describe("applyOpportunityFilters", () => {
  it("emits nothing at all for an empty filter set", () => {
    const { query, calls } = recorder();
    applyOpportunityFilters(query, EMPTY_FILTERS);
    expect(calls).toEqual([]);
  });

  it("bounds discovered_at for freshness", () => {
    const { query, calls } = recorder();
    const now = new Date("2026-09-19T00:00:00.000Z");
    applyOpportunityFilters(query, filters({ freshness: "7" }), now);

    expect(calls).toEqual(["gte:discovered_at=" + freshnessCutoff("7", now)]);
  });

  it("applies country and city as separate any-of clauses", () => {
    const { query, calls } = recorder();
    applyOpportunityFilters(query, filters({ countries: ["India"], cities: ["Bengaluru"] }));
    expect(calls).toEqual(["in:country=India", "in:city=Bengaluru"]);
  });

  it("applies work mode against the stored remote_type vocabulary", () => {
    const { query, calls } = recorder();
    applyOpportunityFilters(query, filters({ workModes: ["on_site"] }));
    expect(calls).toEqual(["in:remote_type=on_site"]);
  });

  it("NEVER applies employment type or seniority, however they are set", () => {
    const { query, calls } = recorder();
    // Set directly, bypassing the UI, to prove the query builder refuses them
    // rather than relying on the disabled control alone.
    applyOpportunityFilters(query, filters({ employmentTypes: ["contract"], seniorities: ["senior"] }));

    expect(calls).toEqual([]);
  });

  it("filters salary on salary_max so a range reaching the floor qualifies", () => {
    const { query, calls } = recorder();
    applyOpportunityFilters(query, filters({ minSalary: 80000, minSalaryCurrency: "USD" }));

    expect(calls).toEqual(["gte:salary_max=80000", "eq:currency=USD"]);
  });

  it("does not constrain currency when no currency is set", () => {
    const { query, calls } = recorder();
    applyOpportunityFilters(query, filters({ minSalary: 80000 }));
    expect(calls).toEqual(["gte:salary_max=80000"]);
  });

  it("translates 'not applied' into IS NULL rather than an in-list", () => {
    const { query, calls } = recorder();
    applyOpportunityFilters(query, filters({ applicationStatuses: ["none"] }));
    expect(calls).toEqual(["is:attempt_status=null"]);
  });

  it("mixes 'not applied' with named statuses through an or", () => {
    const { query, calls } = recorder();
    applyOpportunityFilters(query, filters({ applicationStatuses: ["none", "succeeded"] }));
    expect(calls).toEqual(['or:attempt_status.is.null,attempt_status.in.("succeeded")']);
  });

  it("passes in-list values through untouched, letting the client library do the quoting", () => {
    // The quoting that matters for a comma-bearing company name belongs to
    // supabase-js's .in(), not here — this module only builds raw PostgREST
    // strings for the or() and not() paths, and those ARE quoted and are
    // asserted in the exclusion tests below.
    const { query, calls } = recorder();
    applyOpportunityFilters(query, filters({ companies: ["Acme, Inc"] }));
    expect(calls).toEqual(["in:company_name=Acme, Inc"]);
  });

  it("applies trust and source directly", () => {
    const { query, calls } = recorder();
    applyOpportunityFilters(query, filters({ trustStatuses: ["VERIFIED"], sources: ["remotive"] }));
    expect(calls).toEqual(["in:trust_status=VERIFIED", "in:source_code=remotive"]);
  });
});

describe("applyPreferenceExclusions", () => {
  const companyOnly: CandidatePreferences = {
    ...EMPTY_PREFERENCES,
    excludedCompanies: ["Acme, Inc", "Globex"],
  };

  const prefs: CandidatePreferences = {
    ...companyOnly,
    excludedIndustries: ["Gambling"],
  };

  it("applies excluded companies as a NOT IN on every query", () => {
    const { query, calls } = recorder();
    const result = applyPreferenceExclusions(query, companyOnly);

    expect(calls).toEqual(['not:company_name.in.("Acme, Inc","Globex")']);
    expect(result.unapplied).toEqual([]);
  });

  it("reports excluded industries as unapplied rather than silently doing nothing", () => {
    const { query } = recorder();
    const result = applyPreferenceExclusions(query, prefs);

    // The view exposes no industry column, so claiming this took effect would be
    // a lie the candidate could not detect.
    expect(result.unapplied).toEqual(["Excluded industries"]);
  });

  it("does nothing when there are no preferences", () => {
    const { query, calls } = recorder();
    expect(applyPreferenceExclusions(query, null)).toEqual({ query, unapplied: [] });
    expect(calls).toEqual([]);
  });
});

describe("applyOpportunitySort", () => {
  it("orders best match by priority then recency, so paging is stable", () => {
    const { query, calls } = recorder();
    const result = applyOpportunitySort(query, "best_match");

    expect(calls).toEqual(["order:priority_score:desc", "order:last_seen_at:desc"]);
    expect(result.applied).toBe("best_match");
  });

  it("orders newest by discovery", () => {
    const { query, calls } = recorder();
    applyOpportunitySort(query, "newest");
    expect(calls).toEqual(["order:discovered_at:desc", "order:last_seen_at:desc"]);
  });

  it("orders highest salary by salary_max", () => {
    const { query, calls } = recorder();
    applyOpportunitySort(query, "highest_salary");
    expect(calls).toEqual(["order:salary_max:desc", "order:last_seen_at:desc"]);
  });

  it.each(["company_rating", "work_life_balance", "recently_verified"] as const)(
    "falls back to best match for the unavailable %s sort instead of ordering arbitrarily",
    (sortId) => {
      const { query, calls } = recorder();
      const result = applyOpportunitySort(query, sortId);

      expect(calls).toEqual(["order:priority_score:desc", "order:last_seen_at:desc"]);
      expect(result.applied).toBe("best_match");
    },
  );
});

describe("smart inheritance", () => {
  const prefs: CandidatePreferences = {
    ...EMPTY_PREFERENCES,
    preferredCountries: ["India"],
    remotePreference: "remote",
    minSalary: 80000,
    minSalaryCurrency: "USD",
    employmentTypes: ["contract"],
  };

  it("seeds location, work mode and salary from the profile", () => {
    const derived = deriveFiltersFromPreferences(prefs);

    expect(derived.countries).toEqual(["India"]);
    expect(derived.workModes).toEqual(["remote"]);
    expect(derived.minSalary).toBe(80000);
    expect(derived.minSalaryCurrency).toBe("USD");
  });

  it("does NOT seed employment type, because the filter cannot be applied", () => {
    // Seeding a disabled control would put a value in it and imply it was doing
    // something, which is the duplication-in-reverse this task is removing.
    expect(deriveFiltersFromPreferences(prefs).employmentTypes).toEqual([]);
  });

  it("treats a stated 'any' remote preference as no narrowing", () => {
    const derived = deriveFiltersFromPreferences({ ...EMPTY_PREFERENCES, remotePreference: "any" });
    expect(derived.workModes).toEqual([]);
  });

  it("returns empty filters when the candidate has never set any", () => {
    expect(deriveFiltersFromPreferences(null)).toEqual(EMPTY_FILTERS);
  });

  it("labels a filter that still equals its inherited value", () => {
    const inherited = inheritedFilterLabels(deriveFiltersFromPreferences(prefs), prefs);
    expect(inherited).toContain("countries");
    expect(inherited).toContain("workModes");
    expect(inherited).toContain("minSalary");
  });

  it("stops labelling a filter once the candidate changes it for this search", () => {
    const changed = { ...deriveFiltersFromPreferences(prefs), minSalary: 120000 };
    expect(inheritedFilterLabels(changed, prefs)).not.toContain("minSalary");
    // The others are untouched, so they stay labelled.
    expect(inheritedFilterLabels(changed, prefs)).toContain("countries");
  });

  it("labels nothing when there is no profile to inherit from", () => {
    expect(inheritedFilterLabels(EMPTY_FILTERS, null)).toEqual([]);
  });

  it("does not call an empty filter inherited from an empty preference", () => {
    // Nothing was stated, so nothing was inherited — the distinction matters
    // because the label would otherwise appear on a brand-new account.
    expect(inheritedFilterLabels(EMPTY_FILTERS, EMPTY_PREFERENCES)).toEqual([]);
  });
});

describe("countActiveFilters", () => {
  it("is zero for an empty set", () => {
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
  });

  it("counts a location filter once even when both country and city are set", () => {
    expect(countActiveFilters(filters({ countries: ["India"], cities: ["Pune"] }))).toBe(1);
  });

  it("never counts the unavailable fields", () => {
    expect(countActiveFilters(filters({ employmentTypes: ["contract"], seniorities: ["senior"] }))).toBe(0);
  });

  it("counts every available field that is set", () => {
    expect(
      countActiveFilters(
        filters({
          freshness: "7",
          countries: ["India"],
          workModes: ["remote"],
          minSalary: 50000,
          companies: ["Acme"],
          trustStatuses: ["VERIFIED"],
          applicationStatuses: ["none"],
          sources: ["remotive"],
        }),
      ),
    ).toBe(8);
  });
});

describe("filterOpportunitiesByRoleRelevance", () => {
  const job = (title: string) => ({ title });

  /** Built by the real builder, so the filter is handed a genuine SearchPreferences. */
  const preferencesWithRoles = (targetRoles: string[]) =>
    buildSearchPreferences(
      {
        preferredCountries: [],
        preferredCities: [],
        remotePreference: null,
        employmentTypes: [],
        minSalary: null,
        minSalaryCurrency: null,
        openToAnyLocation: true,
        excludedCompanies: [],
        excludedIndustries: [],
      },
      targetRoles,
    );

  it("keeps only Data Engineering jobs for a candidate who selected Data Engineer", () => {
    const kept = filterOpportunitiesByRoleRelevance(
      [
        job("Senior Data Engineer"),
        job("Azure Data Engineer"),
        job("Data Analyst"),
        job("Marketing Manager"),
        job("Sales Executive"),
      ],
      preferencesWithRoles(["Data Engineer"]),
    ).map((entry) => entry.title);

    // "Data Analyst" shares the word "data" and is still not the role; one
    // shared word is not the job.
    expect(kept).toEqual(["Senior Data Engineer", "Azure Data Engineer"]);
  });

  it("keeps Frontend jobs and excludes Data Engineering for Frontend Developer", () => {
    const kept = filterOpportunitiesByRoleRelevance(
      [job("Frontend Engineer"), job("React Developer"), job("Data Engineer"), job("Backend Engineer")],
      // The alias form of the taxonomy title "Frontend Engineer".
      preferencesWithRoles(["Frontend Developer"]),
    ).map((entry) => entry.title);

    expect(kept).toEqual(["Frontend Engineer", "React Developer"]);
  });

  it("returns every job when no target roles are selected", () => {
    const rows = [job("Data Engineer"), job("Marketing Manager")];

    expect(filterOpportunitiesByRoleRelevance(rows, preferencesWithRoles([]))).toEqual(rows);
    // A blank role is "not selected", not a role that matches everything.
    expect(filterOpportunitiesByRoleRelevance(rows, preferencesWithRoles(["   "]))).toEqual(rows);
    // No object at all means the feed has not resolved its preferences yet.
    expect(filterOpportunitiesByRoleRelevance(rows, null)).toEqual(rows);
  });

  it("includes a job that matches an alias or a taxonomy skill", () => {
    const kept = filterOpportunitiesByRoleRelevance(
      [job("ETL Developer"), job("Spark Engineer"), job("Graphic Designer")],
      preferencesWithRoles(["Data Engineer"]),
    ).map((entry) => entry.title);

    expect(kept).toEqual(["ETL Developer", "Spark Engineer"]);
  });

  it("matches a custom role outside the taxonomy by its own words", () => {
    const kept = filterOpportunitiesByRoleRelevance(
      [job("Senior Blockchain Wizard"), job("Data Engineer")],
      preferencesWithRoles(["Blockchain Wizard"]),
    ).map((entry) => entry.title);

    expect(kept).toEqual(["Senior Blockchain Wizard"]);
  });
});

describe("applySearchPreferenceConstraints", () => {
  const preferences = (overrides: Partial<SearchPreferences> = {}): SearchPreferences => ({
    ...buildSearchPreferences(null, []),
    ...overrides,
  });

  it("emits work mode, salary and company-exclusion clauses", () => {
    const { query, calls } = recorder();
    const { unapplied } = applySearchPreferenceConstraints(
      query,
      preferences({
        workMode: "remote",
        salary: { min: 80000, currency: "USD" },
        exclusions: { companies: ["Acme, Inc"], industries: [] },
      }),
    );

    expect(calls).toEqual([
      "in:remote_type=remote",
      "gte:salary_max=80000",
      "eq:currency=USD",
      'not:company_name.in.("Acme, Inc")',
    ]);
    expect(unapplied).toEqual([]);
  });

  it("constrains nothing for an empty object or no object", () => {
    const empty = recorder();
    applySearchPreferenceConstraints(empty.query, preferences());
    expect(empty.calls).toEqual([]);

    const absent = recorder();
    expect(applySearchPreferenceConstraints(absent.query, null)).toEqual({ query: absent.query, unapplied: [] });
  });

  it("reports excluded industries as unapplied rather than silent", () => {
    const { query } = recorder();
    const result = applySearchPreferenceConstraints(
      query,
      preferences({ exclusions: { companies: [], industries: ["Gambling"] } }),
    );

    expect(result.unapplied).toEqual(["Excluded industries"]);
  });
});

describe("evaluateSearchPreferenceEligibility", () => {
  const preferences = (overrides: Partial<SearchPreferences> = {}): SearchPreferences => ({
    ...buildSearchPreferences(null, []),
    targetRoles: ["Data Engineer"],
    workMode: "remote",
    locations: { countries: ["India"], cities: [], openToAny: false },
    salary: { min: 60000, currency: "USD" },
    exclusions: { companies: ["Acme Corp"], industries: [] },
    isComplete: true,
    ...overrides,
  });

  const job = (overrides: Partial<SearchPreferenceJob> = {}): SearchPreferenceJob => ({
    title: "Senior Data Engineer",
    companyName: "Globex",
    country: "India",
    city: "Bengaluru",
    industry: "Software",
    remoteType: "remote",
    salary: { max: 90000, currency: "USD" },
    ...overrides,
  });

  it("passes a job that satisfies every search preference", () => {
    const ledger = evaluateSearchPreferenceEligibility(preferences(), job());

    expect(ledger.eligible).toBe(true);
    expect(Object.values(ledger.gates).every((gate) => gate.status === "pass")).toBe(true);
  });

  it("maps each failed gate to its reasonCode and its human sentence", () => {
    const role = evaluateSearchPreferenceEligibility(preferences(), job({ title: "Marketing Manager" }));
    expect(role.gates.role_match.reasonCode).toBe("role_mismatch");
    expect(ineligibilityReasonOf(role.gates)).toBe("this job doesn't match the roles you selected");

    const company = evaluateSearchPreferenceEligibility(preferences(), job({ companyName: "acme corp" }));
    expect(company.gates.excluded_company.reasonCode).toBe("excluded_company");
    expect(ineligibilityReasonOf(company.gates)).toBe("you've excluded this company");

    const mode = evaluateSearchPreferenceEligibility(preferences(), job({ remoteType: "on_site" }));
    expect(mode.gates.work_mode.reasonCode).toBe("work_mode_mismatch");
    expect(ineligibilityReasonOf(mode.gates)).toBe("this job's work mode doesn't match what you're looking for");

    const salary = evaluateSearchPreferenceEligibility(
      preferences(),
      job({ salary: { max: 50000, currency: "USD" } }),
    );
    expect(salary.gates.salary.reasonCode).toBe("below_min_salary");
    expect(ineligibilityReasonOf(salary.gates)).toBe("the advertised salary is below your minimum");
  });

  it("treats unstated roles, work mode and salary as no constraint", () => {
    const unconstrained = preferences({
      targetRoles: [],
      workMode: null,
      locations: { countries: [], cities: [], openToAny: true },
      salary: { min: null, currency: null },
      exclusions: { companies: [], industries: [] },
    });

    const ledger = evaluateSearchPreferenceEligibility(
      unconstrained,
      job({ title: "Marketing Manager", companyName: null, remoteType: null, salary: { max: null, currency: null } }),
    );

    expect(ledger.eligible).toBe(true);
  });
});
