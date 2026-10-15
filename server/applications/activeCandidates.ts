import type { SupabaseClient } from "@supabase/supabase-js";

interface CandidateIdRow {
  candidate_id: string;
}

/**
 * Candidates eligible for AUTOMATED WORK this cycle — the system acting ON their behalf:
 * automation_authorizations.status === 'authorized' AND at least one candidate_selected_roles
 * row (MP-R1). Used by automated application submission (applications/runner.ts).
 *
 * THIS IS NOT THE FIT RULE, and it used to claim it was. The Phase 2.1 fit enqueue applied
 * the same predicate — which meant the analysis was gated on consent to ACT, so a candidate
 * who had confirmed facts but never authorized automation received no fit scores at all,
 * and once the 200-vacancy fan-out cap landed they could never receive more than the newest
 * 200. Fit analysis is candidate-facing output, not an action on the candidate's behalf, so
 * the fit paths use findFitAnalysisCandidateIds below instead.
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

/**
 * Candidates a FIT ANALYSIS should exist for: anyone with a CONFIRMED FACT or a SELECTED
 * ROLE — the union of the two signals the DB triggers already act on.
 *
 * WHY NOT findActiveCandidateIds. That one is the automation gate and is correct there: it
 * decides who the system may act FOR. A fit score is not an action on a candidate's behalf —
 * fit_analyses carries a candidate-facing SELECT policy — so gating it on automation consent
 * hides scores from exactly the candidates who have not opted in yet, the population the
 * score exists to convince. The DB triggers never had that gate; this function is the
 * TypeScript mesh agreeing with them rather than with itself.
 *
 * ONLY 'confirmed' COUNTS. fact_confirmations.status is pending/confirmed/rejected, and a
 * rejected correction is not evidence — the same status loadConfirmedFacts treats as usable.
 *
 * NEITHER READ IS A URI RISK, however large these tables grow: both are unfiltered reads,
 * and only an in() filter puts ids into the query string.
 */
export async function findFitAnalysisCandidateIds(client: SupabaseClient): Promise<string[]> {
  const candidateIds = new Set<string>();

  const { data: factRows, error: factError } = await client
    .from("fact_confirmations")
    .select("extracted_facts(candidate_id)")
    .eq("status", "confirmed");

  if (factError) {
    throw factError;
  }

  for (const row of (factRows ?? []) as Array<{ extracted_facts?: { candidate_id?: string } | null }>) {
    const candidateId = row.extracted_facts?.candidate_id;
    if (typeof candidateId === "string") {
      candidateIds.add(candidateId);
    }
  }

  const { data: roleRows, error: roleError } = await client
    .from("candidate_selected_roles")
    .select("candidate_id");

  if (roleError) {
    throw roleError;
  }

  for (const row of (roleRows ?? []) as CandidateIdRow[]) {
    candidateIds.add(row.candidate_id);
  }

  return [...candidateIds];
}
