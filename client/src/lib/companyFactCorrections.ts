import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * R5.4b client layer — same split as employer.ts: reads go straight
 * through Supabase (RLS scopes company_fact_corrections to the caller's
 * own rows via company_fact_corrections_select_own), writes go through
 * server-side Express routes under service_role.
 */
export const CORRECTABLE_FIELDS = [
  "companies.displayed_name",
  "companies.domain",
  "companies.career_domain",
  "company_profiles.headquarters_country",
  "company_profiles.industry",
  "company_profiles.founded_year",
  "company_profiles.employee_size_range",
  "company_profiles.public_private_status",
] as const;

export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

/** Matches each field's server-side FIELD_SPECS label, for the correction form's field picker. */
export const CORRECTABLE_FIELD_LABELS: Record<CorrectableField, string> = {
  "companies.displayed_name": "Company name",
  "companies.domain": "Company domain",
  "companies.career_domain": "Careers page domain",
  "company_profiles.headquarters_country": "Headquarters country",
  "company_profiles.industry": "Industry",
  "company_profiles.founded_year": "Founded year",
  "company_profiles.employee_size_range": "Employee size range",
  "company_profiles.public_private_status": "Public/private status",
};

export const CORRECTION_STATUSES = ["pending", "approved", "rejected"] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export interface CompanyFactCorrection {
  id: string;
  companyId: string;
  fieldName: CorrectableField;
  status: CorrectionStatus;
  proposedValue: string;
  evidence: string | null;
  rationale: string | null;
  createdAt: string;
}

interface CompanyFactCorrectionRow {
  id: string;
  company_id: string;
  field_name: CorrectableField;
  status: CorrectionStatus;
  proposed_value: string;
  evidence: string | null;
  rationale: string | null;
  created_at: string;
}

const GENERIC_LIST_FAILURE_MESSAGE = "Could not load your fact corrections. Please try again.";

export type ListMyCompanyFactCorrectionsResult =
  | { kind: "success"; corrections: CompanyFactCorrection[] }
  | { kind: "error"; message: string };

export async function listMyCompanyFactCorrections(
  client: Pick<SupabaseClient, "from">,
): Promise<ListMyCompanyFactCorrectionsResult> {
  try {
    const { data, error } = await client
      .from("company_fact_corrections")
      .select("id, company_id, field_name, status, proposed_value, evidence, rationale, created_at")
      .order("created_at", { ascending: false });

    if (error || !data) {
      return { kind: "error", message: GENERIC_LIST_FAILURE_MESSAGE };
    }

    const rows = data as unknown as CompanyFactCorrectionRow[];

    return {
      kind: "success",
      corrections: rows.map((row) => ({
        id: row.id,
        companyId: row.company_id,
        fieldName: row.field_name,
        status: row.status,
        proposedValue: row.proposed_value,
        evidence: row.evidence,
        rationale: row.rationale,
        createdAt: row.created_at,
      })),
    };
  } catch {
    return { kind: "error", message: GENERIC_LIST_FAILURE_MESSAGE };
  }
}

const GENERIC_SUBMIT_FAILURE_MESSAGE = "Could not submit your correction. Please try again.";

export type SubmitCompanyFactCorrectionResult = { kind: "success" } | { kind: "error"; message: string };

export async function submitCompanyFactCorrection(
  companyId: string,
  fieldName: CorrectableField,
  proposedValue: string,
  evidence: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitCompanyFactCorrectionResult> {
  let response: Response;

  try {
    response = await fetchImpl(`/api/employer/companies/${companyId}/corrections`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        fieldName,
        proposedValue,
        evidence: evidence.trim() === "" ? undefined : evidence,
      }),
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (!response.ok) {
    let message = GENERIC_SUBMIT_FAILURE_MESSAGE;

    try {
      const body = await response.json();
      if (typeof body?.error === "string" && body.error.trim() !== "") {
        message = body.error;
      }
    } catch {
      // Fall back to the generic message.
    }

    return { kind: "error", message };
  }

  return { kind: "success" };
}

export interface CompanyFactCorrectionQueueEntry {
  id: string;
  companyId: string;
  companyName: string;
  fieldName: CorrectableField;
  currentValue: string | null;
  proposedValue: string;
  evidence: string | null;
  createdAt: string;
}

const GENERIC_QUEUE_FAILURE_MESSAGE = "Could not load the fact corrections queue. Please try again.";

export type GetCompanyFactCorrectionsQueueResult =
  | { kind: "success"; entries: CompanyFactCorrectionQueueEntry[] }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

export async function getCompanyFactCorrectionsQueue(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GetCompanyFactCorrectionsQueueResult> {
  let response: Response;

  try {
    response = await fetchImpl("/api/moderation/company-corrections", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "forbidden" };
  }

  if (!response.ok) {
    return { kind: "error", message: GENERIC_QUEUE_FAILURE_MESSAGE };
  }

  const entries = (await response.json()) as CompanyFactCorrectionQueueEntry[];
  return { kind: "success", entries };
}

export const CORRECTION_DECISIONS = ["approved", "rejected"] as const;
export type CorrectionDecisionValue = (typeof CORRECTION_DECISIONS)[number];

const GENERIC_DECISION_FAILURE_MESSAGE = "Could not record this decision. Please try again.";

export type SubmitCorrectionDecisionResult = { kind: "success" } | { kind: "error"; message: string };

export async function submitCorrectionDecision(
  correctionId: string,
  decision: CorrectionDecisionValue,
  rationale: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitCorrectionDecisionResult> {
  let response: Response;

  try {
    response = await fetchImpl(`/api/moderation/company-corrections/${correctionId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ decision, rationale }),
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (!response.ok) {
    let message = GENERIC_DECISION_FAILURE_MESSAGE;

    try {
      const body = await response.json();
      if (typeof body?.error === "string" && body.error.trim() !== "") {
        message = body.error;
      }
    } catch {
      // Fall back to the generic message.
    }

    return { kind: "error", message };
  }

  return { kind: "success" };
}
