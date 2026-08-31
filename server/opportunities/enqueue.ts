import type { SupabaseClient } from "@supabase/supabase-js";
import { findActiveCandidateIds } from "../applications/activeCandidates.js";

/**
 * Response Intelligence Phase 2.1 — enqueue fit-analysis jobs when a
 * vacancy transitions into VERIFIED (called from server/trust/scoreVacancy.ts).
 *
 * The candidate-side path (facts confirmed) is handled by the
 * fit_enqueue_on_fact_confirmed DB trigger, not TypeScript — fact
 * confirmation is a browser-side RLS UPDATE with no server hook — so there
 * is deliberately no enqueueFitJobsForCandidate here (YAGNI).
 *
 * Idempotent: one fit_analysis_jobs row per (candidate, vacancy) pair,
 * upserted. Re-arming an existing done/failed row to 'pending' is how a
 * re-analysis is requested.
 */
export async function enqueueFitJobsForVacancy(
  client: SupabaseClient,
  vacancyId: string,
): Promise<{ enqueued: number }> {
  const candidateIds = await findActiveCandidateIds(client);

  if (candidateIds.length === 0) {
    return { enqueued: 0 };
  }

  const rows = candidateIds.map((candidateId) => ({
    candidate_id: candidateId,
    vacancy_id: vacancyId,
    status: "pending",
    attempts: 0,
    last_error: null,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await client
    .from("fit_analysis_jobs")
    .upsert(rows, { onConflict: "candidate_id,vacancy_id" });

  if (error) {
    throw error;
  }

  return { enqueued: rows.length };
}
