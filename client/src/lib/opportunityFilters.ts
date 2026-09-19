import type { OpportunitySummary } from "./opportunities";

/**
 * Client-side filtering for the Opportunities filter bar (Mini-Phase 2).
 *
 * SCOPE AND ITS HONEST LIMITS. Filtering happens over the rows the panel has
 * already loaded — listOpportunities pages 25 at a time out of SQL — so a
 * result count here is "matches among loaded rows", never the true total.
 * The bulk-action label says "loaded matches" for exactly that reason.
 *
 * The state itself lives in OpportunitiesPanel as local useState, matching
 * TargetRolesPanel's precedent. Only the pure predicates live here, so they
 * can be tested without rendering a component — the same split
 * roleTaxonomy.ts/roleSuggestions.ts already use against TargetRolesPanel.
 */

export const WORKPLACE_OPTIONS = [
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "on-site", label: "On-site" },
] as const;

export type WorkplaceValue = (typeof WORKPLACE_OPTIONS)[number]["value"];

/**
 * CORRECTION (Mini-Phase 3 investigation): an earlier version of this comment
 * claimed remote_type was unconstrained free text. It is not —
 * 20260813205333_vacancies.sql constrains it to exactly
 * ('remote', 'hybrid', 'on_site'). The normalisation and containment below
 * are therefore looser than the column actually requires, but they are kept
 * deliberately: they are what makes the stored 'on_site' match the UI's
 * "On-site" option without a lookup table, and they stay correct if an
 * adapter ever writes a near-miss spelling.
 *
 * Strictness still matters in one direction: a row whose remote_type is null,
 * blank, or an unrecognised value matches NO option rather than being guessed
 * into one. That is why selecting a workplace filter can legitimately return
 * zero rows — every remote_type in the current corpus is null.
 */
const WORKPLACE_MATCH_TOKENS: Record<WorkplaceValue, string> = {
  remote: "remote",
  hybrid: "hybrid",
  "on-site": "onsite",
};

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function matchesWorkplaceFilter(
  opportunity: Pick<OpportunitySummary, "remoteType">,
  selected: readonly WorkplaceValue[],
): boolean {
  if (selected.length === 0) {
    return true;
  }

  if (opportunity.remoteType === null || opportunity.remoteType.trim() === "") {
    return false;
  }

  const normalized = normalize(opportunity.remoteType);
  return selected.some((value) => normalized.includes(WORKPLACE_MATCH_TOKENS[value]));
}

/**
 * The stored column vocabulary ('on_site') differs from the UI's option value
 * ('on-site'), so a card chip cannot render the raw column value. Before
 * Mini-Phase 3 this chip never rendered at all (every row was null), so the
 * raw-value bug it would otherwise show — "on_site" appearing verbatim in
 * candidate-facing copy — only became reachable once adapters started
 * populating the column.
 *
 * An unrecognised value is returned as-is rather than hidden or blanked:
 * showing something odd beats silently dropping information the row carries.
 */
const WORKPLACE_DB_VALUES: Record<string, WorkplaceValue> = {
  remote: "remote",
  hybrid: "hybrid",
  on_site: "on-site",
};

export function workplaceLabel(remoteType: string | null): string | null {
  if (remoteType === null || remoteType.trim() === "") {
    return null;
  }

  const value = WORKPLACE_DB_VALUES[remoteType.trim().toLowerCase()];
  return value ? (WORKPLACE_OPTIONS.find((option) => option.value === value)?.label ?? value) : remoteType;
}

export interface OpportunityFilters {
  workplace: readonly WorkplaceValue[];
}

export const NO_OPPORTUNITY_FILTERS: OpportunityFilters = { workplace: [] };

export function hasActiveOpportunityFilters(filters: OpportunityFilters): boolean {
  return filters.workplace.length > 0;
}

/**
 * Applied in render via useMemo. Rows with no fit analysis yet are kept —
 * a filter is a narrowing of what is shown, and "not analysed" is not a
 * reason to hide a job.
 */
export function applyOpportunityFilters(
  opportunities: readonly OpportunitySummary[],
  filters: OpportunityFilters,
): OpportunitySummary[] {
  return opportunities.filter((opportunity) => matchesWorkplaceFilter(opportunity, filters.workplace));
}
