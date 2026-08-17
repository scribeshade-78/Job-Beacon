import type { SupabaseClient } from "@supabase/supabase-js";

/** Matches the vacancy_reports.category check constraint exactly (PRD §13.1). */
export const REPORT_CATEGORIES = [
  "fake_job",
  "payment_request",
  "impersonation",
  "salary_mismatch",
  "expired_job",
  "misleading_remote_status",
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export interface SubmitVacancyReportInput {
  vacancyId: string;
  reporterId: string;
  category: ReportCategory;
  description?: string;
}

export interface SubmitVacancyReportResult {
  id: string;
}

/**
 * reporterId must come from the verified session (request.user.id), never
 * from client-supplied input — the same identity-trust boundary every
 * other candidate-facing write in this project already holds to.
 */
export async function submitVacancyReport(
  client: SupabaseClient,
  input: SubmitVacancyReportInput,
): Promise<SubmitVacancyReportResult> {
  const { data, error } = await client
    .from("vacancy_reports")
    .insert({
      vacancy_id: input.vacancyId,
      reporter_id: input.reporterId,
      category: input.category,
      description: input.description ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw error ?? new Error("Failed to insert vacancy_reports row — no row returned.");
  }

  return { id: (data as { id: string }).id };
}
