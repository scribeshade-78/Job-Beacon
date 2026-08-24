import type { SupabaseClient } from "@supabase/supabase-js";

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
  trust_status: OpportunityTrustStatus | null;
  companies: { displayed_name: string; domain: string | null } | null;
  vacancy_trust_scores: Array<{ score: number | null }> | null;
  application_plans: Array<{
    id: string;
    status: string;
    gate_results: { eligible: boolean } | null;
  }> | null;
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
      };
    });

    return { kind: "success", opportunities };
  } catch {
    return { kind: "error", message: FAILURE_MESSAGE };
  }
}