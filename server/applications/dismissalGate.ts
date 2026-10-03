import type { SupabaseClient } from "@supabase/supabase-js";
import type { GateResult } from "./eligibilityGate.js";

/**
 * The candidate's own per-vacancy dismissal (dismissed_vacancies,
 * 20261001120000), enforced wherever work could otherwise be created.
 *
 * WHY A GATE AND NOT JUST A FEED FILTER. Hiding a job in the browser is a
 * display decision; a caller can post a vacancy id straight to the queue
 * endpoint. "Dismissed" has to mean the system refuses, not that the UI does not
 * offer it — the same reason readinessGate exists beside the Home card.
 *
 * SERVICE-ROLE SAFETY. RLS does NOT apply to a service-role client, so every
 * read here carries an explicit candidate_id predicate. Dropping it would turn
 * this gate into "did ANY candidate dismiss this vacancy" — a cross-candidate
 * leak that would silently block everybody else's applications.
 *
 * A QUERY ERROR THROWS, matching every other gate: an outage must not be
 * reported to the candidate as "you dismissed this".
 */
export async function isVacancyDismissed(
  client: SupabaseClient,
  candidateId: string,
  vacancyId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("dismissed_vacancies")
    .select("vacancy_id")
    .eq("candidate_id", candidateId)
    .eq("vacancy_id", vacancyId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data !== null;
}

/** The same rule as an eligibility gate, for the queue-time evaluation. */
export async function evaluateDismissal(
  client: SupabaseClient,
  candidateId: string,
  vacancyId: string,
): Promise<GateResult> {
  if (await isVacancyDismissed(client, candidateId, vacancyId)) {
    return { status: "fail", reasonCode: "VACANCY_DISMISSED", detail: { vacancyId } };
  }

  return { status: "pass" };
}
