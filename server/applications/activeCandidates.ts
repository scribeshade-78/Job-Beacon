import type { SupabaseClient } from "@supabase/supabase-js";

interface CandidateIdRow {
  candidate_id: string;
}

/**
 * Candidates eligible for automated work this cycle:
 * automation_authorizations.status === 'authorized' AND at least one
 * candidate_selected_roles row (MP-R1). Two-step query (authorized ids,
 * then which of those have a role row) mirrors the existing two-step style
 * (evaluateVerifiedFacts, resumeExtraction.ts's listExtractedFacts) rather
 * than a single joined query neither table's client-side helpers use.
 *
 * Extracted here (was private in runner.ts) so the Phase 2.1 fit-analysis
 * enqueue (server/opportunities/enqueue.ts) applies the exact same
 * definition of "active candidate" — one rule, no driftable copy.
 */
export async function findActiveCandidateIds(client: SupabaseClient): Promise<string[]> {
  const { data: authRows, error: authError } = await client
    .from("automation_authorizations")
    .select("candidate_id")
    .eq("status", "authorized");

  if (authError) {
    throw authError;
  }

  const authorizedCandidateIds = ((authRows ?? []) as CandidateIdRow[]).map((row) => row.candidate_id);

  if (authorizedCandidateIds.length === 0) {
    return [];
  }

  const { data: roleRows, error: roleError } = await client
    .from("candidate_selected_roles")
    .select("candidate_id")
    .in("candidate_id", authorizedCandidateIds);

  if (roleError) {
    throw roleError;
  }

  return [...new Set(((roleRows ?? []) as CandidateIdRow[]).map((row) => row.candidate_id))];
}
