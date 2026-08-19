import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * §16.4 worker lifecycle states (application_attempts.status check
 * constraint) — kept in sync manually, same precedent as
 * EXCLUSION_CATEGORIES, since the client can't import the server's
 * ACTIVE_ATTEMPT_STATUSES across the client/server tsconfig boundary.
 */
export const APPLICATION_ATTEMPT_STATUSES = [
  "pending",
  "leased",
  "succeeded",
  "failed",
  "action_required",
] as const;

export type ApplicationAttemptStatus = (typeof APPLICATION_ATTEMPT_STATUSES)[number];

export interface ApplicationAttemptSummary {
  id: string;
  status: ApplicationAttemptStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationSummary {
  planId: string;
  vacancyId: string;
  vacancyTitle: string;
  vacancyUrl: string;
  eligible: boolean;
  createdAt: string;
  attempts: ApplicationAttemptSummary[];
}

interface ApplicationPlanRow {
  id: string;
  vacancy_id: string;
  gate_results: { eligible: boolean };
  created_at: string;
  vacancies: { raw_title: string; authoritative_url: string } | null;
  application_attempts: Array<{
    id: string;
    status: ApplicationAttemptStatus;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }> | null;
}

const GENERIC_FAILURE_MESSAGE = "Could not load your applications. Please try again.";

export type ListApplicationsResult =
  | { kind: "success"; applications: ApplicationSummary[] }
  | { kind: "error"; message: string };

/**
 * Reads the caller's own application_plans, joined to vacancies (for
 * display) and application_attempts (for lifecycle status) via RLS —
 * application_plans_select_own and application_attempts_select_own already
 * scope both to auth.uid(), so this is a direct query, not a privileged
 * server route (see the resume_documents/candidate_exclusions precedent).
 * eligible is read straight off gate_results.eligible, the same
 * "derive, don't duplicate" source of truth applicationEngine.ts uses.
 */
export async function listApplications(
  client: Pick<SupabaseClient, "from">,
): Promise<ListApplicationsResult> {
  try {
    const { data, error } = await client
      .from("application_plans")
      .select(
        "id, vacancy_id, gate_results, created_at, vacancies (raw_title, authoritative_url), application_attempts (id, status, attempts, max_attempts, last_error, created_at, updated_at)",
      )
      .order("created_at", { ascending: false });

    if (error || !data) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    const rows = data as unknown as ApplicationPlanRow[];

    return {
      kind: "success",
      applications: rows.map((row) => ({
        planId: row.id,
        vacancyId: row.vacancy_id,
        vacancyTitle: row.vacancies?.raw_title ?? "",
        vacancyUrl: row.vacancies?.authoritative_url ?? "",
        eligible: row.gate_results.eligible,
        createdAt: row.created_at,
        attempts: (row.application_attempts ?? []).map((attempt) => ({
          id: attempt.id,
          status: attempt.status,
          attempts: attempt.attempts,
          maxAttempts: attempt.max_attempts,
          lastError: attempt.last_error,
          createdAt: attempt.created_at,
          updatedAt: attempt.updated_at,
        })),
      })),
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}
