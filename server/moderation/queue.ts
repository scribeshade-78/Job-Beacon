import type { SupabaseClient } from "@supabase/supabase-js";

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface ModerationQueueEntry {
  caseId: string;
  vacancyId: string;
  vacancyTitle: string;
  vacancyUrl: string;
  sourceType: string;
  severity: string;
  evidenceSnapshot: unknown;
  createdAt: string;
}

interface ModerationCaseRow {
  id: string;
  vacancy_id: string;
  source_type: string;
  severity: string;
  evidence_snapshot: unknown;
  created_at: string;
  vacancies: { raw_title: string; authoritative_url: string } | null;
}

/**
 * Lists open cases — moderation_cases with no moderation_decisions row yet
 * (a case's resolution state is derivable from decision existence; see the
 * R3.5 moderation_cases migration, which deliberately has no status
 * column). No "open" concept exists at the SQL/pgTAP level, so it's
 * computed here: fetch all cases, fetch which case ids already have a
 * decision, exclude those. "Frozen evidence" is moderation_cases'
 * evidence_snapshot column directly (§13.2 step 25) — no join to
 * vacancy_evidence needed. Ordered by severity (critical first), then
 * oldest-first within a tier.
 */
export async function getModerationQueue(client: SupabaseClient): Promise<ModerationQueueEntry[]> {
  const { data: cases, error: casesError } = await client
    .from("moderation_cases")
    .select("id, vacancy_id, source_type, severity, evidence_snapshot, created_at, vacancies (raw_title, authoritative_url)");

  if (casesError) {
    throw casesError;
  }

  const { data: decidedRows, error: decidedError } = await client
    .from("moderation_decisions")
    .select("moderation_case_id");

  if (decidedError) {
    throw decidedError;
  }

  const decidedCaseIds = new Set(
    ((decidedRows ?? []) as Array<{ moderation_case_id: string }>).map((row) => row.moderation_case_id),
  );

  const openCases = ((cases ?? []) as unknown as ModerationCaseRow[]).filter((row) => !decidedCaseIds.has(row.id));

  return openCases
    .map((row) => ({
      caseId: row.id,
      vacancyId: row.vacancy_id,
      vacancyTitle: row.vacancies?.raw_title ?? "",
      vacancyUrl: row.vacancies?.authoritative_url ?? "",
      sourceType: row.source_type,
      severity: row.severity,
      evidenceSnapshot: row.evidence_snapshot,
      createdAt: row.created_at,
    }))
    .sort((a, b) => {
      const severityDelta = (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99);
      return severityDelta !== 0 ? severityDelta : a.createdAt.localeCompare(b.createdAt);
    });
}
