import type { SupabaseClient } from "@supabase/supabase-js";

export class UnverifiedEmployerError extends Error {}
export class VacancyNotFoundError extends Error {}
export class DuplicatePendingAppealError extends Error {}

interface DecisionRow {
  id: string;
  moderation_case_id: string;
  rationale: string;
  policy_version: string;
  created_at: string;
}

export interface BlockedVacancyEntry {
  vacancyId: string;
  title: string;
  url: string;
  decisionId: string;
  decisionRationale: string;
  decisionPolicyVersion: string;
  decisionCreatedAt: string;
  hasPendingAppeal: boolean;
}

/**
 * moderation_cases/moderation_decisions are service_role-only (no
 * authenticated grant at all — see their migrations), so this can't be an
 * RLS-direct read the way listMyEmployerClaims is; it has to be this
 * server route's join. A vacancy can accumulate more than one
 * moderation_cases row over its life (the original rule/report case, then
 * later an 'employer_appeal' case) — "why is this currently blocked" is
 * the single most recent decision across ALL of a vacancy's cases, not
 * the latest decision per case, so decisions are grouped by vacancy_id
 * here, not by case id.
 */
export async function listEmployerBlockedVacancies(
  client: SupabaseClient,
  companyId: string,
): Promise<BlockedVacancyEntry[]> {
  const { data: vacancies, error: vacanciesError } = await client
    .from("vacancies")
    .select("id, raw_title, authoritative_url")
    .eq("company_id", companyId)
    .eq("trust_status", "BLOCKED");

  if (vacanciesError) {
    throw vacanciesError;
  }

  const vacancyRows = (vacancies ?? []) as Array<{ id: string; raw_title: string; authoritative_url: string }>;

  if (vacancyRows.length === 0) {
    return [];
  }

  const vacancyIds = vacancyRows.map((row) => row.id);

  const { data: cases, error: casesError } = await client
    .from("moderation_cases")
    .select("id, vacancy_id")
    .in("vacancy_id", vacancyIds);

  if (casesError) {
    throw casesError;
  }

  const caseRows = (cases ?? []) as Array<{ id: string; vacancy_id: string }>;
  const caseIdToVacancyId = new Map(caseRows.map((row) => [row.id, row.vacancy_id]));
  const caseIds = caseRows.map((row) => row.id);

  const latestDecisionByVacancy = new Map<string, DecisionRow>();

  if (caseIds.length > 0) {
    const { data: decisions, error: decisionsError } = await client
      .from("moderation_decisions")
      .select("id, moderation_case_id, rationale, policy_version, created_at")
      .in("moderation_case_id", caseIds)
      .order("created_at", { ascending: false });

    if (decisionsError) {
      throw decisionsError;
    }

    for (const decision of (decisions ?? []) as DecisionRow[]) {
      const vacancyId = caseIdToVacancyId.get(decision.moderation_case_id);
      if (vacancyId && !latestDecisionByVacancy.has(vacancyId)) {
        latestDecisionByVacancy.set(vacancyId, decision);
      }
    }
  }

  const pendingAppealVacancyIds = await findVacancyIdsWithPendingAppeal(client, vacancyIds);

  return vacancyRows
    .map((row) => {
      const decision = latestDecisionByVacancy.get(row.id);

      if (!decision) {
        // No decision found for a BLOCKED vacancy shouldn't happen in
        // practice, but there's nothing to appeal without one — excluded
        // below rather than returned with an invented decisionId.
        return null;
      }

      return {
        vacancyId: row.id,
        title: row.raw_title,
        url: row.authoritative_url,
        decisionId: decision.id,
        decisionRationale: decision.rationale,
        decisionPolicyVersion: decision.policy_version,
        decisionCreatedAt: decision.created_at,
        hasPendingAppeal: pendingAppealVacancyIds.has(row.id),
      };
    })
    .filter((entry): entry is BlockedVacancyEntry => entry !== null);
}

async function findVacancyIdsWithPendingAppeal(client: SupabaseClient, vacancyIds: string[]): Promise<Set<string>> {
  const { data: appealCases, error: appealCasesError } = await client
    .from("moderation_cases")
    .select("id, vacancy_id")
    .in("vacancy_id", vacancyIds)
    .eq("source_type", "employer_appeal");

  if (appealCasesError) {
    throw appealCasesError;
  }

  const appealCaseRows = (appealCases ?? []) as Array<{ id: string; vacancy_id: string }>;

  if (appealCaseRows.length === 0) {
    return new Set();
  }

  const appealCaseIds = appealCaseRows.map((row) => row.id);
  const { data: appealDecisions, error: appealDecisionsError } = await client
    .from("moderation_decisions")
    .select("moderation_case_id")
    .in("moderation_case_id", appealCaseIds);

  if (appealDecisionsError) {
    throw appealDecisionsError;
  }

  const decidedCaseIds = new Set(
    ((appealDecisions ?? []) as Array<{ moderation_case_id: string }>).map((row) => row.moderation_case_id),
  );

  return new Set(appealCaseRows.filter((row) => !decidedCaseIds.has(row.id)).map((row) => row.vacancy_id));
}

export interface SubmitVacancyAppealInput {
  userId: string;
  companyId: string;
  vacancyId: string;
  rationale: string;
  evidence?: string;
}

/** PRD §20.3 "Evidence submission deadline" — approved default (R5.4c): 7 days from filing. */
const EVIDENCE_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Filing writes two rows: the vacancy_appeals row itself, then a new
 * moderation_cases row (source_type='employer_appeal') linked back to it
 * via appeal_id — approved R5.4c design, reusing the exact same
 * open/decided derivation, decision-writing function, and
 * reviewer-separation trigger every other moderation case already has,
 * rather than a parallel appeals-specific resolution path. Severity is
 * inherited from the original case (approved decision) — an appeal of a
 * high-severity block is still high-severity work.
 */
export async function submitVacancyAppeal(client: SupabaseClient, input: SubmitVacancyAppealInput): Promise<{ id: string }> {
  const { data: claim, error: claimError } = await client
    .from("employer_claims")
    .select("id")
    .eq("user_id", input.userId)
    .eq("company_id", input.companyId)
    .eq("status", "verified")
    .maybeSingle();

  if (claimError) {
    throw claimError;
  }

  if (!claim) {
    throw new UnverifiedEmployerError("No verified employer claim found for this company.");
  }

  const { data: vacancy, error: vacancyError } = await client
    .from("vacancies")
    .select("id, company_id")
    .eq("id", input.vacancyId)
    .maybeSingle();

  if (vacancyError) {
    throw vacancyError;
  }

  if (!vacancy || (vacancy as { company_id: string | null }).company_id !== input.companyId) {
    throw new VacancyNotFoundError(`No vacancy found with id "${input.vacancyId}" for this company.`);
  }

  const { data: cases, error: casesError } = await client
    .from("moderation_cases")
    .select("id, severity")
    .eq("vacancy_id", input.vacancyId);

  if (casesError) {
    throw casesError;
  }

  const caseRows = (cases ?? []) as Array<{ id: string; severity: string }>;
  const caseIds = caseRows.map((row) => row.id);

  if (caseIds.length === 0) {
    throw new VacancyNotFoundError(`No moderation case found for vacancy "${input.vacancyId}" to appeal.`);
  }

  const { data: latestDecisionRows, error: latestDecisionError } = await client
    .from("moderation_decisions")
    .select("id, moderation_case_id, created_at")
    .in("moderation_case_id", caseIds)
    .order("created_at", { ascending: false })
    .limit(1);

  if (latestDecisionError) {
    throw latestDecisionError;
  }

  const latestDecision = (latestDecisionRows ?? [])[0] as { id: string; moderation_case_id: string } | undefined;

  if (!latestDecision) {
    throw new VacancyNotFoundError(`No moderation decision found for vacancy "${input.vacancyId}" to appeal.`);
  }

  const pendingAppealVacancyIds = await findVacancyIdsWithPendingAppeal(client, [input.vacancyId]);

  if (pendingAppealVacancyIds.has(input.vacancyId)) {
    throw new DuplicatePendingAppealError("An appeal for this vacancy is already pending.");
  }

  const severity = caseRows.find((row) => row.id === latestDecision.moderation_case_id)?.severity ?? "medium";
  const evidenceDeadline = new Date(Date.now() + EVIDENCE_DEADLINE_MS).toISOString();

  const { data: appeal, error: appealError } = await client
    .from("vacancy_appeals")
    .insert({
      moderation_decision_id: latestDecision.id,
      filer_id: input.userId,
      rationale: input.rationale,
      evidence: input.evidence ? { text: input.evidence } : null,
      evidence_deadline: evidenceDeadline,
    })
    .select("id")
    .single();

  if (appealError || !appeal) {
    throw appealError ?? new Error("Failed to insert vacancy_appeals row — no row returned.");
  }

  const appealId = (appeal as { id: string }).id;

  const { error: caseInsertError } = await client.from("moderation_cases").insert({
    vacancy_id: input.vacancyId,
    source_type: "employer_appeal",
    severity,
    evidence_snapshot: { rationale: input.rationale, evidence: input.evidence ?? null },
    appeal_id: appealId,
  });

  if (caseInsertError) {
    throw caseInsertError;
  }

  return { id: appealId };
}

export interface AppealQueueEntry {
  caseId: string;
  appealId: string;
  vacancyId: string;
  vacancyTitle: string;
  vacancyUrl: string;
  appealRationale: string;
  appealEvidence: unknown;
  evidenceDeadline: string | null;
  originalDecisionId: string;
  originalDecisionRationale: string;
  originalDecisionPolicyVersion: string;
  createdAt: string;
}

interface AppealCaseRow {
  id: string;
  vacancy_id: string;
  appeal_id: string | null;
  created_at: string;
  vacancies: { raw_title: string; authoritative_url: string } | null;
}

/** Open (undecided) employer_appeal cases — same "cases with no decision row yet" derivation getModerationQueue already uses, filtered to this source_type and joined with the appeal's own detail plus the original decision it's appealing. */
export async function getAppealsQueue(client: SupabaseClient): Promise<AppealQueueEntry[]> {
  const { data: cases, error: casesError } = await client
    .from("moderation_cases")
    .select("id, vacancy_id, appeal_id, created_at, vacancies (raw_title, authoritative_url)")
    .eq("source_type", "employer_appeal");

  if (casesError) {
    throw casesError;
  }

  const caseRows = (cases ?? []) as unknown as AppealCaseRow[];

  if (caseRows.length === 0) {
    return [];
  }

  const caseIds = caseRows.map((row) => row.id);
  const { data: decidedRows, error: decidedError } = await client
    .from("moderation_decisions")
    .select("moderation_case_id")
    .in("moderation_case_id", caseIds);

  if (decidedError) {
    throw decidedError;
  }

  const decidedCaseIds = new Set(
    ((decidedRows ?? []) as Array<{ moderation_case_id: string }>).map((row) => row.moderation_case_id),
  );
  const openCases = caseRows.filter((row) => !decidedCaseIds.has(row.id) && row.appeal_id);

  if (openCases.length === 0) {
    return [];
  }

  const appealIds = openCases.map((row) => row.appeal_id as string);
  const { data: appeals, error: appealsError } = await client
    .from("vacancy_appeals")
    .select("id, moderation_decision_id, rationale, evidence, evidence_deadline")
    .in("id", appealIds);

  if (appealsError) {
    throw appealsError;
  }

  const appealRows = (appeals ?? []) as Array<{
    id: string;
    moderation_decision_id: string;
    rationale: string;
    evidence: unknown;
    evidence_deadline: string | null;
  }>;
  const appealsById = new Map(appealRows.map((row) => [row.id, row]));

  const originalDecisionIds = [...new Set(appealRows.map((row) => row.moderation_decision_id))];
  const { data: originalDecisions, error: originalDecisionsError } = await client
    .from("moderation_decisions")
    .select("id, rationale, policy_version")
    .in("id", originalDecisionIds);

  if (originalDecisionsError) {
    throw originalDecisionsError;
  }

  const originalDecisionsById = new Map(
    ((originalDecisions ?? []) as Array<{ id: string; rationale: string; policy_version: string }>).map((row) => [
      row.id,
      row,
    ]),
  );

  return openCases
    .map((row) => {
      const appeal = appealsById.get(row.appeal_id as string)!;
      const originalDecision = originalDecisionsById.get(appeal.moderation_decision_id);

      return {
        caseId: row.id,
        appealId: appeal.id,
        vacancyId: row.vacancy_id,
        vacancyTitle: row.vacancies?.raw_title ?? "",
        vacancyUrl: row.vacancies?.authoritative_url ?? "",
        appealRationale: appeal.rationale,
        appealEvidence: appeal.evidence,
        evidenceDeadline: appeal.evidence_deadline,
        originalDecisionId: appeal.moderation_decision_id,
        originalDecisionRationale: originalDecision?.rationale ?? "",
        originalDecisionPolicyVersion: originalDecision?.policy_version ?? "",
        createdAt: row.created_at,
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
