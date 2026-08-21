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
 * The two trust_status values eligibilityGate.ts's evaluateVacancyTrust
 * treats as auto-apply-eligible (VACANCY_TRUST_ELIGIBLE_STATUSES) — a
 * reported vacancy shouldn't remain fully trusted (and therefore still
 * eligible for the R7 automated application engine) while waiting for a
 * moderator to look at it.
 */
const DEMOTABLE_TRUST_STATUSES = ["VERIFIED", "VERIFIED_INCOMPLETE"] as const;
const DEMOTED_TRUST_STATUS = "UNDER_REVIEW";

/**
 * reporterId must come from the verified session (request.user.id), never
 * from client-supplied input — the same identity-trust boundary every
 * other candidate-facing write in this project already holds to.
 *
 * After recording the report, immediately demotes the vacancy's
 * trust_status to UNDER_REVIEW — but only conditionally, via this update's
 * own `.in(DEMOTABLE_TRUST_STATUSES)` filter, not by fetching the current
 * status and branching in application code first. That keeps the
 * transition race-safe (the same "let the WHERE clause decide, don't
 * fetch-then-branch" discipline claim_application_attempt's cancellation
 * sweep and resolveActionRequiredEvent's scoped update already use) and
 * naturally makes this a safe no-op for every other status: already
 * UNDER_REVIEW, a stricter status (FLAGGED, BLOCKED, EXPIRED_REMOVED,
 * ACTION_REQUIRED), or not yet scored (NULL) — none of those match the
 * filter, so none of them are touched or "upgraded" back toward VERIFIED.
 *
 * Deliberately does NOT create a moderation_cases row or call
 * scoreVacancy(): moderation_cases.severity has no PRD-specified
 * category -> severity mapping to assign here, and re-running scoreVacancy
 * synchronously — using the same deterministic signals as before, since a
 * report itself isn't a signal scoreVacancy's hard-block/weighted-score
 * functions read — would most likely just recompute the same VERIFIED
 * outcome and silently undo this demotion. Both are left for a later,
 * separately-scoped mini-phase once those rules actually exist.
 *
 * Not wrapped in a transaction — no RPC exists for this yet, the same
 * "two separate writes" shape actionRequired.ts's createActionRequiredEvent
 * already uses, and this follows its exact precedent: if the second write
 * (the demotion) fails, this throws rather than swallowing the error, even
 * though the first write (the report) has already durably committed and
 * is not rolled back. A torn write here just leaves a recorded report
 * against a vacancy whose trust_status wasn't demoted this one time — a
 * safe failure mode (the report is still there for a moderator to find),
 * not a silently lost report.
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

  const { error: demotionError } = await client
    .from("vacancies")
    .update({ trust_status: DEMOTED_TRUST_STATUS })
    .eq("id", input.vacancyId)
    .in("trust_status", DEMOTABLE_TRUST_STATUSES);

  if (demotionError) {
    throw demotionError;
  }

  return { id: (data as { id: string }).id };
}
