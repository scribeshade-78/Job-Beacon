import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computePriorityScore,
  isResponseCategory,
  type PriorityScore,
  type ResponseCategory,
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

/** Latest response classification for one (candidate, vacancy) pair. */
interface ResponseStageInfo {
  category: ResponseCategory | null;
  deadlineIso: string | null;
  classifiedAt: string;
}

/** Peel one embed level, tolerating PostgREST returning an object or a 1-element array. */
function embedChild(node: unknown, key: string): unknown {
  const n = Array.isArray(node) ? node[0] : node;
  return n && typeof n === "object" ? (n as Record<string, unknown>)[key] : undefined;
}

/**
 * Walks response_classifications -> messages -> application_attempts ->
 * application_plans.vacancy_id. Defensive because the embed shape (object
 * vs array at each hop) is not guaranteed.
 */
function classificationVacancyId(messagesNode: unknown): string | null {
  const attempts = embedChild(messagesNode, "application_attempts");
  let plan = embedChild(attempts, "application_plans");
  if (Array.isArray(plan)) plan = plan[0];
  const vid = plan && typeof plan === "object" ? (plan as Record<string, unknown>).vacancy_id : undefined;
  return typeof vid === "string" ? vid : null;
}

/**
 * This candidate's latest response classification per vacancy, reached
 * through the application chain. RLS scopes rows to the signed-in
 * candidate. Returns an empty map on any query error — response stage
 * then just falls back to neutral in the priority score.
 */
async function loadResponseStages(
  client: Pick<SupabaseClient, "from">,
): Promise<Map<string, ResponseStageInfo>> {
  const byVacancy = new Map<string, ResponseStageInfo>();

  const { data, error } = await client
    .from("response_classifications")
    .select(
      "category, classified_at, extracted_deadline, messages!inner(application_attempts!inner(application_plans!inner(vacancy_id)))",
    );

  if (error || !data) {
    return byVacancy;
  }

  for (const raw of data as unknown[]) {
    const row = raw as {
      category: string | null;
      classified_at: string;
      extracted_deadline: string | null;
      messages: unknown;
    };
    const vacancyId = classificationVacancyId(row.messages);
    if (!vacancyId) continue;

    const prev = byVacancy.get(vacancyId);
    if (!prev || row.classified_at > prev.classifiedAt) {
      byVacancy.set(vacancyId, {
        category: isResponseCategory(row.category) ? row.category : null,
        deadlineIso: row.extracted_deadline,
        classifiedAt: row.classified_at,
      });
    }
  }

  return byVacancy;
}

/** This candidate's free-text selected role names (RLS-scoped). */
async function loadSelectedRoles(client: Pick<SupabaseClient, "from">): Promise<string[]> {
  const { data, error } = await client.from("candidate_selected_roles").select("role_name");
  if (error || !data) {
    return [];
  }
  return (data as Array<{ role_name: string }>).map((r) => r.role_name);
}

const DAY_MS = 86_400_000;

/** Whole days from now to `iso`; null when absent or unparseable. */
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / DAY_MS);
}

/** Nearest (soonest) deadline in days across the given ISO timestamps. */
function nearestDeadlineDays(isos: Array<string | null>): number | null {
  const days = isos.map(daysUntil).filter((n): n is number => n !== null);
  return days.length > 0 ? Math.min(...days) : null;
}

/**
 * Mirrors server/applications/eligibilityGate.ts evaluateRoleMatch: plain
 * case-insensitive substring of a selected role name in the title. null
 * when the candidate has selected no roles (no preference signal).
 */
function resolveRoleMatch(title: string, roles: string[]): boolean | null {
  if (roles.length === 0) return null;
  const t = title.toLowerCase();
  return roles.some((role) => {
    const n = role.trim().toLowerCase();
    return n.length > 0 && t.includes(n);
  });
}

function normalizeRemoteType(v: string | null): "remote" | "hybrid" | "on_site" | null {
  return v === "remote" || v === "hybrid" || v === "on_site" ? v : null;
}

/**
 * Fetches this candidate's fit_analyses rows for the listed vacancies (RLS
 * scopes them to the signed-in candidate automatically) plus the Phase
 * 2.3a priority signals (latest response stage, selected roles), and
 * attaches the §12.1 priority score. Any lookup failure is swallowed — the
 * Opportunities list must still render without fit data rather than error
 * out entirely; a missing signal just leaves that factor neutral.
 *
 * company_credibility (§12.1, 5%) is deliberately left neutral: its source
 * is vacancy_trust_scores.score, which the candidate's browser role cannot
 * read (its only `authenticated` grant is behind a moderator RLS policy).
 * Wiring it needs a server-side compute path — deferred to Phase 2.3b.
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
        "vacancy_id, technical_fit_score, practical_eligibility_score, eligibility_capped, hard_blockers, missing_evidence, top_reasons, jd_text_available",
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

    const [stages, selectedRoles] = await Promise.all([
      loadResponseStages(client),
      loadSelectedRoles(client),
    ]);
    const rowById = new Map(rows.map((r) => [r.id, r]));

    for (const opp of opportunities) {
      const fit = byVacancy.get(opp.id);
      if (!fit) {
        continue;
      }
      const row = rowById.get(opp.id);
      const stage = stages.get(opp.id);

      opp.fitAnalysis = {
        priority: computePriorityScore({
          technicalFitScore: fit.technical_fit_score,
          practicalEligibilityScore: fit.practical_eligibility_score,
          eligibilityCapped: fit.eligibility_capped,
          responseCategory: stage?.category ?? null,
          hasApplication: (row?.application_plans?.length ?? 0) > 0,
          remoteType: normalizeRemoteType(row?.remote_type ?? null),
          salary: row
            ? { min: row.salary_min, max: row.salary_max, source: row.salary_source }
            : null,
          deadlineDays: nearestDeadlineDays([row?.expires_at ?? null, stage?.deadlineIso ?? null]),
          roleMatch: resolveRoleMatch(opp.title, selectedRoles),
        }),
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