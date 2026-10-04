import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computePriorityScore,
  daysUntil,
  finalizeWithFreshUrgency,
  PRIORITY_SCORE_VERSION,
  type PriorityFactor,
  type PriorityFactorComponent,
  type PriorityScore,
} from "../../../shared/priorityScore";

export type OpportunityTrustStatus =
  | "VERIFIED"
  | "VERIFIED_INCOMPLETE"
  | "UNDER_REVIEW"
  | "FLAGGED"
  | "BLOCKED"
  | "EXPIRED_REMOVED"
  | "ACTION_REQUIRED";

export type OpportunityAutoApplyStatus =
  | "not_started"
  | "queued"
  | "in_progress"
  | "action_required"
  | "completed"
  | "failed"
  /**
   * application_attempts.status = 'submitting': the submission boundary was
   * crossed, so an external attempt may have begun, but no authoritative
   * confirmation is stored. Deliberately NOT 'not_started' (that would say
   * nothing happened) and NOT 'completed' (that would claim acceptance we
   * cannot evidence).
   */
  | "needs_verification"
  /**
   * The submission boundary was crossed and a confirmation IS stored, but the
   * finalizing status write has not landed. Accepted, awaiting reconciliation —
   * distinct from needs_verification, where no confirmation exists at all.
   */
  | "reconciliation_pending";

export interface OpportunitySalary {
  min: number | null;
  max: number | null;
  currency: string | null;
  interval: string | null;
  source: "employer_disclosed" | "estimated" | null;
}

export function formatSalary(salary: OpportunitySalary): string {
  const { min, max, currency, interval, source } = salary;

  if (min === null && max === null) {
    return "Not disclosed";
  }

  const curr = currency ?? "USD";
  const intv = interval ?? "year";

  let range: string;
  if (min !== null && max !== null && min !== max) {
    range = `${formatNumber(min)}–${formatNumber(max)}`;
  } else if (min !== null) {
    range = `${formatNumber(min)}+`;
  } else {
    range = `Up to ${formatNumber(max!)}`;
  }

  const sourceLabel = source === "employer_disclosed" ? "employer disclosed" : "estimated";

  return `${curr} ${range}/${intv} (${sourceLabel})`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(n);
}

export interface OpportunityReasonEntry {
  code: string;
  detail: string;
}

/**
 * The candidate-facing slice of a fit_analyses row (Phase 2.1) plus the
 * Phase 2.2 weighted §12.1 priority score computed on read.
 */
export interface OpportunityFitAnalysis {
  priority: PriorityScore;
  technicalFitScore: number | null;
  practicalEligibilityScore: number | null;
  eligibilityCapped: boolean;
  hardBlockers: OpportunityReasonEntry[];
  missingEvidence: string[];
  topReasons: string[];
  jdTextAvailable: boolean;
}

export interface OpportunitySummary {
  id: string;
  title: string;
  url: string;
  companyName: string | null;
  companyDomain: string | null;
  location: string;
  /** Raw view columns, used by the shared preference ledger's location gate. */
  country: string | null;
  city: string | null;
  remoteType: string | null;
  trustStatus: OpportunityTrustStatus;
  /**
   * Which source this listing came from. Surfaced because some sources require
   * attribution as a condition of using their data (Remotive's terms require it
   * explicitly), and because "where did this job come from" is a fair question
   * for a candidate to be able to answer from the listing itself.
   */
  sourceCode: string;
  salary: OpportunitySalary;
  discoveredAt: string;
  lastSeenAt: string;
  autoApplyStatus: OpportunityAutoApplyStatus;
  /** null until the fit-analysis worker has produced a fit_analyses row for this candidate x vacancy. */
  fitAnalysis: OpportunityFitAnalysis | null;
}

/**
 * One row of the candidate_opportunities view (Phase 2.3c). The view has
 * already applied the verified + active filter and, via security_invoker,
 * scoped the fit-analysis and application-plan columns to this candidate,
 * so there is no second query and no merge step here any more.
 */
interface OpportunityRow {
  id: string;
  raw_title: string;
  authoritative_url: string;
  country: string | null;
  region: string | null;
  city: string | null;
  remote_type: string | null;
  currency: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_interval: string | null;
  salary_source: "employer_disclosed" | "estimated" | null;
  discovered_at: string;
  last_seen_at: string;
  expires_at: string | null;
  trust_status: OpportunityTrustStatus | null;
  source_code: string;

  company_name: string | null;
  company_domain: string | null;

  plan_gate_results: { eligible: boolean } | null;
  /** Latest application_attempts.status for this candidate's plan, if any. */
  attempt_status: string | null;
  /**
   * Whether THAT SAME attempt has a trustworthy acceptance confirmation
   * (candidate_opportunities.attempt_accepted_evidence, 20261001180000). NULL
   * on an un-migrated database, which must be read as NOT accepted.
   */
  attempt_accepted_evidence: boolean | null;

  technical_fit_score: number | null;
  practical_eligibility_score: number | null;
  eligibility_capped: boolean | null;
  hard_blockers: OpportunityReasonEntry[] | null;
  missing_evidence: string[] | null;
  top_reasons: string[] | null;
  jd_text_available: boolean | null;

  /** Phase 2.3b stored §12.1 score. Null until the fit worker has scored this pair. */
  priority_score: number | null;
  priority_uncapped_score: number | null;
  priority_components: Record<PriorityFactor, PriorityFactorComponent> | null;
  priority_score_version: string | null;
}

import type { SortId } from "../../../shared/opportunityQuery";
import type { SearchPreferences } from "../../../shared/searchPreferences";
import {
  EMPTY_FILTERS,
  applyOpportunityFilters,
  applyOpportunitySort,
  applySearchPreferenceConstraints,
  inList,
  type FilterableQuery,
  type OpportunityFilters,
} from "./opportunityQuery";

const FAILURE_MESSAGE = "Could not load opportunities. Please try again.";

/** Rows per page. The panel pages through with `offset`. */
export const OPPORTUNITIES_PAGE_SIZE = 25;

export interface ListOpportunitiesOptions {
  /** 0-based row offset. Defaults to 0 (first page). */
  offset?: number;
  /** Rows to fetch. Defaults to OPPORTUNITIES_PAGE_SIZE. */
  limit?: number;
  /**
   * Task I — the on-the-fly filter state. Applied SERVER-SIDE, so a page covers
   * the filtered set rather than filtering one already-loaded page. Omitted, the
   * query is exactly what it was before this task.
   */
  filters?: OpportunityFilters;
  /**
   * The unified SearchPreferences object (Phase 1 Task 5) — the single source
   * of truth for the feed's standing constraints: work mode, salary floor and
   * name exclusions. Deliberately not the filter seeds: seeding is a UI starting
   * value and happens in the panel, while these apply to every request.
   */
  searchPreferences?: SearchPreferences | null;
  /**
   * Vacancies the candidate has dismissed (jobDecisions.ts). Dismissal beats a
   * save, so this list is dismissed ids only, and it is applied as a query
   * clause rather than a post-fetch filter: filtering after range() would make a
   * page silently return fewer rows than OPPORTUNITIES_PAGE_SIZE.
   */
  excludeVacancyIds?: readonly string[];
  /** Task I — which of the 6 sorts to apply. An unavailable sort falls back to best match. */
  sort?: SortId;
}

export type ListOpportunitiesResult =
  | {
      kind: "success";
      opportunities: OpportunitySummary[];
      /** True when the view returned a full page, i.e. another page may exist. */
      hasMore: boolean;
    }
  | { kind: "error"; message: string };

/**
 * Maps the candidate's latest application_attempts.status onto the badge
 * vocabulary. The gate decision still gates everything: an ineligible plan
 * reads as not_started regardless of any attempt.
 *
 * The cases below are the full application_attempts.status CHECK constraint
 * — pending / leased / succeeded / failed / action_required / cancelled.
 * (The pre-2.3c version of this switch matched invented names like "draft",
 * "generating" and "completed" that the schema never had, alongside reading
 * a non-existent application_plans.status.)
 */
function mapAutoApplyStatus(row: OpportunityRow): OpportunityAutoApplyStatus {
  if (!(row.plan_gate_results?.eligible ?? false)) {
    return "not_started";
  }

  switch (row.attempt_status) {
    case "pending":
      return "queued";
    case "leased":
      return "in_progress";
    case "action_required":
      return "action_required";
    case "submitting":
      return row.attempt_accepted_evidence === true ? "reconciliation_pending" : "needs_verification";
    case "succeeded":
      // 'succeeded' is the worker's claim; the confirmation is the proof. A bare
      // success — or a missing field on an un-migrated database — is NOT Applied.
      return row.attempt_accepted_evidence === true ? "completed" : "needs_verification";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      // No attempt yet (null), or a status added to the schema since.
      return "not_started";
  }
}

function formatLocation(row: OpportunityRow): string {
  const parts = [row.city, row.region, row.country].filter(Boolean);
  if (parts.length === 0) {
    return "Location not specified";
  }
  return parts.join(", ");
}

const VIEW_COLUMNS = [
  "id",
  "raw_title",
  "authoritative_url",
  "country",
  "region",
  "city",
  "remote_type",
  "currency",
  "salary_min",
  "salary_max",
  "salary_interval",
  "salary_source",
  "discovered_at",
  "last_seen_at",
  "expires_at",
  "trust_status",
  "source_code",
  "company_name",
  "company_domain",
  "plan_gate_results",
  "attempt_status",
  "attempt_accepted_evidence",
  "technical_fit_score",
  "practical_eligibility_score",
  "eligibility_capped",
  "hard_blockers",
  "missing_evidence",
  "top_reasons",
  "jd_text_available",
  "priority_score",
  "priority_uncapped_score",
  "priority_components",
  "priority_score_version",
].join(", ");

/**
 * A view row carries a fit analysis only once the fit worker has written
 * one. jd_text_available is NOT NULL on fit_analyses, so its being null
 * here means the LEFT JOIN found no row at all.
 */
function buildFitAnalysis(row: OpportunityRow): OpportunityFitAnalysis | null {
  if (row.jd_text_available === null) {
    return null;
  }

  const capped = row.eligibility_capped ?? false;

  return {
    priority: buildPriority(row, capped),
    technicalFitScore: row.technical_fit_score,
    practicalEligibilityScore: row.practical_eligibility_score,
    eligibilityCapped: capped,
    hardBlockers: row.hard_blockers ?? [],
    missingEvidence: row.missing_evidence ?? [],
    topReasons: row.top_reasons ?? [],
    jdTextAvailable: row.jd_text_available,
  };
}

/**
 * The source_code of the seeded [MOCK] "local fixture" postings, created by the
 * 20260917*_local_fixture_*.sql migrations. Debug scaffolding for the
 * application engine — a fixture employer that submits nowhere — never a real
 * listing a candidate should see.
 */
const FIXTURE_SOURCE_CODE = "local_fixture";

/**
 * Phase 2.3c: reads the candidate_opportunities view, which has already
 * applied the verified + active filter, joined the company, plan and fit
 * columns, and (through security_invoker RLS) scoped the per-candidate ones
 * to the caller. One query, no merge step.
 *
 * Ordering and paging happen in SQL. For the best-match sort that means the
 * STORED priority_score, and the displayed score is then refreshed for urgency
 * decay (see buildPriority) — which can move a row by at most urgency's weight,
 * so the page is re-sorted locally to stay visually monotonic. A row can still
 * sit on the "wrong" side of a page boundary by that much; correcting it would
 * mean duplicating the urgency ladder in SQL, which is not worth a 5% factor.
 *
 * THAT LOCAL RE-SORT IS CONFINED TO BEST MATCH, and the confinement is the
 * point. Task I added four other sorts, and re-sorting every page by priority
 * regardless of which one was asked for meant SQL selected the page in the
 * requested order and this function then scrambled it back — so "Newest" and
 * "Highest salary" returned the right ROWS in the wrong ORDER, while the panel
 * labelled them as sorted. The urgency-decay rationale above only ever applied
 * to the one sort that orders by that score.
 */
export async function listOpportunities(
  client: Pick<SupabaseClient, "from">,
  options: ListOpportunitiesOptions = {},
): Promise<ListOpportunitiesResult> {
  const limit = options.limit ?? OPPORTUNITIES_PAGE_SIZE;
  const offset = options.offset ?? 0;

  try {
    // Task I. Filter, then exclude, then sort, then page — the order the clauses
    // are documented in shared/opportunityQuery.ts, and the order that makes an
    // emitted query readable in a log.
    const filtered = applyOpportunityFilters(
      client.from("candidate_opportunities").select(VIEW_COLUMNS) as unknown as FilterableQuery,
      options.filters ?? EMPTY_FILTERS,
    );

    const { query: excluded } = applySearchPreferenceConstraints(
      // The [MOCK] local-fixture postings are real rows in this view, so they
      // are excluded here rather than deleted — the application-engine fixtures
      // depend on them, and removing production rows is a separate decision.
      // Applied BEFORE paging on purpose: filtering after range() would make a
      // page silently return fewer than OPPORTUNITIES_PAGE_SIZE rows.
      filtered.not("source_code", "eq", FIXTURE_SOURCE_CODE) as FilterableQuery,
      options.searchPreferences ?? null,
    );

    const excludeIds = options.excludeVacancyIds ?? [];
    const withoutDismissed =
      excludeIds.length === 0
        ? excluded
        : (excluded.not("id", "in", inList(excludeIds)) as FilterableQuery);

    const { query: sorted, applied: appliedSort } = applyOpportunitySort(withoutDismissed, options.sort);

    // The structural FilterableQuery type describes only what this module needs;
    // range() is not part of it because nothing in the filter or sort logic
    // pages, so it is reached through the real builder here.
    const paged = sorted as unknown as {
      range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }>;
    };

    const { data, error } = await paged.range(offset, offset + limit - 1);

    if (error || !data) {
      return { kind: "error", message: FAILURE_MESSAGE };
    }

    const rows = data as unknown as OpportunityRow[];

    const opportunities: OpportunitySummary[] = rows.map((row) => ({
      id: row.id,
      title: row.raw_title,
      url: row.authoritative_url,
      companyName: row.company_name,
      companyDomain: row.company_domain,
      location: formatLocation(row),
      country: row.country,
      city: row.city,
      remoteType: row.remote_type,
      trustStatus: row.trust_status ?? "UNDER_REVIEW",
      sourceCode: row.source_code,
      salary: {
        min: row.salary_min,
        max: row.salary_max,
        currency: row.currency,
        interval: row.salary_interval,
        source: row.salary_source,
      },
      discoveredAt: row.discovered_at,
      lastSeenAt: row.last_seen_at,
      autoApplyStatus: mapAutoApplyStatus(row),
      fitAnalysis: buildFitAnalysis(row),
    }));

    // Only best match re-sorts locally; see the note above. For every other sort
    // SQL's ordering IS the answer and touching it again would undo the request.
    if (appliedSort === "best_match") {
      sortByPriority(opportunities);
    }

    return { kind: "success", opportunities, hasMore: rows.length === limit };
  } catch {
    return { kind: "error", message: FAILURE_MESSAGE };
  }
}

/**
 * Reads specific vacancies by id.
 *
 * Needed because a vacancy just ingested has no fit_analysis yet, so its
 * priority_score is NULL and it sorts below every scored row — it is not on
 * page 1 at all. "Fetch latest jobs" therefore cannot make new jobs visible by
 * re-reading page 1 and hoping; it has to ask for the ids it just created.
 *
 * Deliberately no ordering: the caller has an explicit id list and decides the
 * order (the newest fetch goes on top).
 */
export async function listOpportunitiesByIds(
  client: Pick<SupabaseClient, "from">,
  vacancyIds: readonly string[],
): Promise<ListOpportunitiesResult> {
  if (vacancyIds.length === 0) {
    return { kind: "success", opportunities: [], hasMore: false };
  }

  try {
    const { data, error } = await client
      .from("candidate_opportunities")
      .select(VIEW_COLUMNS)
      .in("id", [...vacancyIds]);

    if (error || !data) {
      return { kind: "error", message: FAILURE_MESSAGE };
    }

    const rows = data as unknown as OpportunityRow[];

    return {
      kind: "success",
      opportunities: rows.map((row) => ({
        id: row.id,
        title: row.raw_title,
        url: row.authoritative_url,
        companyName: row.company_name,
        companyDomain: row.company_domain,
        location: formatLocation(row),
        country: row.country,
        city: row.city,
        remoteType: row.remote_type,
        trustStatus: row.trust_status ?? "UNDER_REVIEW",
        sourceCode: row.source_code,
        salary: {
          min: row.salary_min,
          max: row.salary_max,
          currency: row.currency,
          interval: row.salary_interval,
          source: row.salary_source,
        },
        discoveredAt: row.discovered_at,
        lastSeenAt: row.last_seen_at,
        autoApplyStatus: mapAutoApplyStatus(row),
        fitAnalysis: buildFitAnalysis(row),
      })),
      hasMore: false,
    };
  } catch {
    return { kind: "error", message: FAILURE_MESSAGE };
  }
}

/**
 * Phase 2.3b: the score is computed and stored server-side
 * (server/opportunities/analyzeFit.ts), so the client reads the stored
 * breakdown and refreshes exactly one slice.
 *
 * Urgency is the only factor the re-enqueue mesh cannot keep fresh: it
 * decays with the calendar, not with a data change. So it is recomputed
 * here from the vacancy's *current* expires_at. The classification-deadline
 * half of the stored snapshot is left alone on purpose — extracted_deadline
 * only changes when a new classification is written, and that fires a
 * re-analysis anyway.
 *
 * A row with no stored components, or one written under a different score
 * version (rollout skew, or a row the reconcile pass has not reached yet),
 * falls back to the 2.3a computation over the fit fields alone: real
 * technical/practical factors, the rest neutral. Such rows sort last in SQL
 * (priority_score IS NULL) while displaying a fallback score, so ordering
 * and display disagree until `worker:fit --reconcile` has run.
 */
function buildPriority(row: OpportunityRow, capped: boolean): PriorityScore {
  const components = row.priority_components;

  if (!components || row.priority_score_version !== PRIORITY_SCORE_VERSION) {
    return computePriorityScore({
      technicalFitScore: row.technical_fit_score,
      practicalEligibilityScore: row.practical_eligibility_score,
      eligibilityCapped: capped,
    });
  }

  const uncappedScore = finalizeWithFreshUrgency(components, daysUntil(row.expires_at));

  return {
    score: capped ? 0 : uncappedScore,
    uncappedScore,
    capped,
    components,
    version: row.priority_score_version,
  };
}

/**
 * Re-sorts the fetched page by the urgency-refreshed score. SQL already
 * chose *which* rows are on this page (by the stored score); this only
 * fixes their order within it.
 *
 * Scored opportunities first (priority score desc), then not-yet-analysed
 * ones; last_seen_at desc as the tiebreak within each group. A hard-blocked
 * opportunity has priority 0, so it sinks below eligible ones but stays
 * above "analysis pending".
 */
function sortByPriority(opportunities: OpportunitySummary[]): void {
  opportunities.sort((a, b) => {
    const pa = a.fitAnalysis?.priority.score ?? null;
    const pb = b.fitAnalysis?.priority.score ?? null;

    if (pa !== null && pb !== null && pa !== pb) {
      return pb - pa;
    }
    if (pa !== null && pb === null) {
      return -1;
    }
    if (pa === null && pb !== null) {
      return 1;
    }
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });
}
