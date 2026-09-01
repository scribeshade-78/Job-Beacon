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
  | "failed";

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
  remoteType: string | null;
  trustStatus: OpportunityTrustStatus;
  trustScore: number | null;
  salary: OpportunitySalary;
  discoveredAt: string;
  lastSeenAt: string;
  autoApplyStatus: OpportunityAutoApplyStatus;
  /** null until the fit-analysis worker has produced a fit_analyses row for this candidate x vacancy. */
  fitAnalysis: OpportunityFitAnalysis | null;
}

interface VacancyRow {
  id: string;
  raw_title: string;
  authoritative_url: string;
  company_id: string | null;
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
  companies: { displayed_name: string; domain: string | null } | null;
  vacancy_trust_scores: Array<{ score: number | null }> | null;
  application_plans: Array<{
    id: string;
    status: string;
    gate_results: { eligible: boolean } | null;
  }> | null;
}

interface FitAnalysisRow {
  vacancy_id: string;
  technical_fit_score: number | null;
  practical_eligibility_score: number | null;
  eligibility_capped: boolean;
  hard_blockers: OpportunityReasonEntry[] | null;
  missing_evidence: string[] | null;
  top_reasons: string[] | null;
  jd_text_available: boolean;
  /** Phase 2.3b stored §12.1 score. Null on rows the fit worker has not re-run since the migration. */
  priority_score: number | null;
  priority_uncapped_score: number | null;
  priority_components: Record<PriorityFactor, PriorityFactorComponent> | null;
  priority_score_version: string | null;
}

const FAILURE_MESSAGE = "Could not load opportunities. Please try again.";

const VERIFIED_STATUSES: OpportunityTrustStatus[] = ["VERIFIED", "VERIFIED_INCOMPLETE"];

export type ListOpportunitiesResult =
  | { kind: "success"; opportunities: OpportunitySummary[] }
  | { kind: "error"; message: string };

function mapAutoApplyStatus(plans: VacancyRow["application_plans"]): OpportunityAutoApplyStatus {
  if (!plans || plans.length === 0) {
    return "not_started";
  }

  const plan = plans[0];
  const gateEligible = plan.gate_results?.eligible ?? false;

  if (!gateEligible) {
    return "not_started";
  }

  switch (plan.status) {
    case "pending":
    case "draft":
      return "queued";
    case "in_progress":
    case "generating":
    case "submitting":
      return "in_progress";
    case "action_required":
      return "action_required";
    case "completed":
    case "succeeded":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "not_started";
  }
}

function formatLocation(row: VacancyRow): string {
  const parts = [row.city, row.region, row.country].filter(Boolean);
  if (parts.length === 0) {
    return "Location not specified";
  }
  return parts.join(", ");
}

export async function listOpportunities(
  client: Pick<SupabaseClient, "from">,
): Promise<ListOpportunitiesResult> {
  try {
    const { data, error } = await client
      .from("vacancies")
      .select(
        `
        id,
        raw_title,
        authoritative_url,
        company_id,
        country,
        region,
        city,
        remote_type,
        currency,
        salary_min,
        salary_max,
        salary_interval,
        salary_source,
        discovered_at,
        last_seen_at,
        expires_at,
        trust_status,
        companies (displayed_name, domain),
        vacancy_trust_scores (score),
        application_plans (id, status, gate_results)
      `,
      )
      .in("trust_status", VERIFIED_STATUSES)
      .eq("status", "active")
      .order("last_seen_at", { ascending: false });

    if (error || !data) {
      return { kind: "error", message: FAILURE_MESSAGE };
    }

    const rows = data as unknown as VacancyRow[];

    const opportunities: OpportunitySummary[] = rows.map((row) => {
      const latestScore = row.vacancy_trust_scores?.[0]?.score ?? null;

      return {
        id: row.id,
        title: row.raw_title,
        url: row.authoritative_url,
        companyName: row.companies?.displayed_name ?? null,
        companyDomain: row.companies?.domain ?? null,
        location: formatLocation(row),
        remoteType: row.remote_type,
        trustStatus: row.trust_status ?? "UNDER_REVIEW",
        trustScore: latestScore,
        salary: {
          min: row.salary_min,
          max: row.salary_max,
          currency: row.currency,
          interval: row.salary_interval,
          source: row.salary_source,
        },
        discoveredAt: row.discovered_at,
        lastSeenAt: row.last_seen_at,
        autoApplyStatus: mapAutoApplyStatus(row.application_plans),
        fitAnalysis: null as OpportunityFitAnalysis | null,
      };
    });

    await attachFitAnalyses(client, rows, opportunities);
    sortByPriority(opportunities);

    return { kind: "success", opportunities };
  } catch {
    return { kind: "error", message: FAILURE_MESSAGE };
  }
}

/**
 * Phase 2.3b: the score is computed and stored server-side
 * (server/opportunities/analyzeFit.ts), so the client no longer gathers
 * signals — it reads the stored breakdown and refreshes exactly one slice.
 *
 * Urgency is the only factor the re-enqueue mesh cannot keep fresh: it
 * decays with the calendar, not with a data change. So it is recomputed
 * here from the vacancy's *current* expires_at. The classification-deadline
 * half of the stored snapshot is left alone on purpose — extracted_deadline
 * only changes when a new classification is written, and that fires a
 * re-analysis anyway.
 *
 * A row with no stored components, or one written under a different score
 * version (rollout skew, or a pre-2.3b row the worker has not revisited),
 * falls back to the 2.3a computation over the fit fields alone: real
 * technical/practical factors, the rest neutral.
 */
function buildPriority(fit: FitAnalysisRow, expiresAt: string | null): PriorityScore {
  const components = fit.priority_components;

  if (!components || fit.priority_score_version !== PRIORITY_SCORE_VERSION) {
    return computePriorityScore({
      technicalFitScore: fit.technical_fit_score,
      practicalEligibilityScore: fit.practical_eligibility_score,
      eligibilityCapped: fit.eligibility_capped,
    });
  }

  const uncappedScore = finalizeWithFreshUrgency(components, daysUntil(expiresAt));

  return {
    score: fit.eligibility_capped ? 0 : uncappedScore,
    uncappedScore,
    capped: fit.eligibility_capped,
    components,
    version: fit.priority_score_version,
  };
}

/**
 * Fetches this candidate's fit_analyses rows for the listed vacancies (RLS
 * scopes them to the signed-in candidate automatically) and attaches the
 * stored §12.1 priority score. A fit-lookup failure is swallowed — the
 * Opportunities list must still render without fit data rather than error
 * out entirely.
 */
async function attachFitAnalyses(
  client: Pick<SupabaseClient, "from">,
  rows: VacancyRow[],
  opportunities: OpportunitySummary[],
): Promise<void> {
  if (opportunities.length === 0) {
    return;
  }

  try {
    const { data, error } = await client
      .from("fit_analyses")
      .select(
        "vacancy_id, technical_fit_score, practical_eligibility_score, eligibility_capped, hard_blockers, missing_evidence, top_reasons, jd_text_available, priority_score, priority_uncapped_score, priority_components, priority_score_version",
      )
      .in(
        "vacancy_id",
        opportunities.map((o) => o.id),
      );

    if (error || !data) {
      return;
    }

    const byVacancy = new Map<string, FitAnalysisRow>();
    for (const fit of data as unknown as FitAnalysisRow[]) {
      byVacancy.set(fit.vacancy_id, fit);
    }

    const rowById = new Map(rows.map((r) => [r.id, r]));

    for (const opp of opportunities) {
      const fit = byVacancy.get(opp.id);
      if (!fit) {
        continue;
      }

      opp.fitAnalysis = {
        priority: buildPriority(fit, rowById.get(opp.id)?.expires_at ?? null),
        technicalFitScore: fit.technical_fit_score,
        practicalEligibilityScore: fit.practical_eligibility_score,
        eligibilityCapped: fit.eligibility_capped,
        hardBlockers: fit.hard_blockers ?? [],
        missingEvidence: fit.missing_evidence ?? [],
        topReasons: fit.top_reasons ?? [],
        jdTextAvailable: fit.jd_text_available,
      };
    }
  } catch {
    // fit data is best-effort — leave fitAnalysis null on any failure.
  }
}

/**
 * Scored opportunities first (priority score desc), then not-yet-analysed
 * ones; last_seen_at desc as the tiebreak within each group. A
 * hard-blocked opportunity has priority 0, so it sinks below eligible ones
 * but stays above "analysis pending".
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