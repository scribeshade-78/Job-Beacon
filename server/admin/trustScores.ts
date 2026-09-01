import type { SupabaseClient } from "@supabase/supabase-js";

export interface RecentTrustScoreEntry {
  id: string;
  vacancyId: string;
  vacancyTitle: string;
  status: string;
  score: number | null;
  policyVersion: string;
  scoredAt: string;
}

interface TrustScoreRow {
  id: string;
  vacancy_id: string;
  status: string;
  score: number | null;
  policy_version: string;
  scored_at: string;
  vacancies: { raw_title: string } | null;
}

const DEFAULT_LIMIT = 50;

/** R8.1 Trust Scoring section — read-only, most recent scoring runs first. */
export async function getRecentTrustScores(
  client: SupabaseClient,
  limit: number = DEFAULT_LIMIT,
): Promise<RecentTrustScoreEntry[]> {
  const { data, error } = await client
    .from("vacancy_trust_scores")
    .select("id, vacancy_id, status, score, policy_version, scored_at, vacancies (raw_title)")
    .order("scored_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return ((data ?? []) as unknown as TrustScoreRow[]).map((row) => ({
    id: row.id,
    vacancyId: row.vacancy_id,
    vacancyTitle: row.vacancies?.raw_title ?? "",
    status: row.status,
    score: row.score,
    policyVersion: row.policy_version,
    scoredAt: row.scored_at,
  }));
}
