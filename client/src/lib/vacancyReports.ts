import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Candidate-submitted listing reports (PRD §13.1) — the client for the
 * `vacancy_reports` INSERT that 20260816231312 already grants to
 * `authenticated` with a `reporter_id = auth.uid()` WITH CHECK.
 *
 * WHY THERE IS NO REPORT-STATUS READ HERE. The table's own migration records
 * that triage ("whether/when a report becomes a moderation_cases row") is
 * deliberately not built, so this module submits and stops. Promising the
 * candidate a review outcome the schema cannot represent would be the same
 * class of untruth as a green badge on a pipeline that cannot run.
 *
 * NO RAW DATABASE TEXT. Every failure collapses to one candidate-facing
 * sentence; the Postgres message is not passed through (the same rule
 * candidatePreferences.ts and exclusions.ts follow).
 */

/** The CHECK-constrained categories on vacancy_reports.category. */
export const REPORT_CATEGORIES = [
  "fake_job",
  "payment_request",
  "impersonation",
  "salary_mismatch",
  "expired_job",
  "misleading_remote_status",
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * Candidate-facing wording for each category. A lookup rather than a
 * de-underscored transform: "fake_job" is not a sentence, and the report form
 * is the one place a candidate has to understand exactly what they are claiming.
 */
export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  fake_job: "This looks like a fake job",
  payment_request: "It asks me to pay",
  impersonation: "It impersonates a company",
  salary_mismatch: "The salary does not match the posting",
  expired_job: "This job has already expired",
  misleading_remote_status: "The remote/on-site status is misleading",
};

export function isReportCategory(value: unknown): value is ReportCategory {
  return typeof value === "string" && (REPORT_CATEGORIES as readonly string[]).includes(value);
}

const GENERIC_FAILURE_MESSAGE = "Could not send your report. Please try again.";

/** `description` is free text in the schema, so the cap is enforced here. */
export const MAX_REPORT_DESCRIPTION_LENGTH = 1000;

export type SubmitVacancyReportResult = { kind: "success" } | { kind: "error"; message: string };

/**
 * Inserts one report for `vacancyId` on behalf of `reporterId`.
 *
 * `reporterId` is passed in rather than read from the session so the RLS
 * WITH CHECK is exercised in tests without a live auth server — the same
 * shape setExclusion() uses for candidate_exclusions.
 */
export async function submitVacancyReport(
  client: Pick<SupabaseClient, "from">,
  reporterId: string,
  vacancyId: string,
  category: ReportCategory,
  description: string | null,
): Promise<SubmitVacancyReportResult> {
  const trimmed = (description ?? "").trim();

  try {
    const { error } = await client.from("vacancy_reports").insert({
      vacancy_id: vacancyId,
      reporter_id: reporterId,
      category,
      description:
        trimmed === "" ? null : trimmed.slice(0, MAX_REPORT_DESCRIPTION_LENGTH),
    });

    if (error) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}
