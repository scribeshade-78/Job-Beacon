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
  countActiveFilters,
  deriveFiltersFromPreferences,
  freshnessCutoff,
  inheritedFilterLabels,
  type FilterableQuery,
  type OpportunityFilters,
} from "./opportunityQuery";
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
