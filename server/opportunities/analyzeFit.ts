import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import {
  analyzeTechnicalFit,
  FIT_ANALYSIS_PROMPT_VERSION,
  DEFAULT_FIT_MODEL,
} from "./fitPrompt.js";
import { extractJd, JD_EXTRACTOR_VERSION } from "./jdExtraction.js";
import {
  evaluatePracticalEligibility,
  type PracticalEligibilityInput,
} from "./practicalEligibility.js";
import type { ReasonEntry } from "./reasonCodes.js";
import {
  computePriorityScore,
  nearestDeadlineDays,
  isResponseCategory,
  type PriorityFactor,
  type PriorityFactorComponent,
  type ResponseCategory,
} from "../../shared/priorityScore.js";

/**
 * Response Intelligence Phase 2.1 / Opportunity Intelligence Phase 2.3b —
 * orchestrates one (candidate, vacancy) fit analysis: load confirmed facts
 * + JD text, run the deterministic Practical Eligibility rules engine and
 * (when JD text exists and its inputs actually changed) the AI Technical
 * Fit call, compute the §12.1 weighted priority score, assemble the
 * fit_analyses row. Pure of side effects except one insert into
 * vacancy_jd_snapshots when a snapshot for the current vacancy_version does
 * not exist yet.
 *
 * Phase 2.3b moved priority scoring here from the client. Running under the
 * service-role client is what makes the 8th factor reachable:
 * vacancy_trust_scores is readable only by service_role (its sole
 * `authenticated` grant sits behind a moderator RLS policy), so
 * company_credibility could never be wired in the old client-side
 * compute-on-read.
 *
 * Throws only on genuine failure (DB error, malformed AI output) — the
 * worker turns a throw into a retry/backoff. An absent JD is NOT a throw:
 * the row is returned with jd_text_available = false and no Technical Fit.
 */

export interface AnalyzeFitDeps {
  openai: Pick<OpenAI, "chat">;
}

export interface FitAnalysisRow {
  candidate_id: string;
  vacancy_id: string;
  jd_snapshot_id: string | null;
  jd_text_available: boolean;
  technical_fit_score: number | null;
  technical_fit_components: Record<string, { score: number; rationale: string }> | null;
  missing_evidence: string[];
  practical_eligibility_score: number | null;
  hard_blockers: ReasonEntry[];
  soft_penalties: ReasonEntry[];
  eligibility_capped: boolean;
  top_reasons: string[];
  risks: string[];
  model_version: string;
  prompt_version: string;

  // Phase 2.3b — the stored §12.1 weighted priority score. priority_score
  // is the 8-factor snapshot scalar used as the sort key; readers refresh
  // its urgency slice from priority_components (finalizeWithFreshUrgency).
  priority_score: number | null;
  priority_uncapped_score: number | null;
  priority_components: Record<PriorityFactor, PriorityFactorComponent> | null;
  priority_score_version: string;
}

interface VacancyRow {
  id: string;
  raw_title: string | null;
  source_code: string;
  country: string | null;
  region: string | null;
  city: string | null;
  remote_type: "remote" | "hybrid" | "on_site" | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_source: "employer_disclosed" | "estimated" | null;
  expires_at: string | null;
}

interface ExtractedFactRow {
  id: string;
  fact_type: string;
  fact_value: string;
}

export class FitAnalysisTargetError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "FitAnalysisTargetError";
  }
}

interface ConfirmedFacts {
  facts: Array<{ type: string; value: string }>;
  /**
   * Newest fact_confirmations.updated_at across this candidate's confirmed
   * facts, or null when none are confirmed. The AI-skip guard compares it
   * against the previous analysis's analyzed_at.
   *
   * Only *confirmed* rows are considered, matching the facts set itself. A
   * confirmation later flipped to 'rejected' therefore does not advance
   * this timestamp — an accepted limitation, since
   * fit_enqueue_on_fact_confirmed only fires on transitions *into*
   * 'confirmed' and so a rejection does not request a re-analysis either.
   */
  latestConfirmationAt: string | null;
}

async function loadConfirmedFacts(
  client: SupabaseClient,
  candidateId: string,
): Promise<ConfirmedFacts> {
  const { data: factRows, error: factError } = await client
    .from("extracted_facts")
    .select("id, fact_type, fact_value")
    .eq("candidate_id", candidateId);

  if (factError) {
    throw factError;
  }

  const facts = (factRows ?? []) as ExtractedFactRow[];
  if (facts.length === 0) {
    return { facts: [], latestConfirmationAt: null };
  }

  const { data: confRows, error: confError } = await client
    .from("fact_confirmations")
    .select("extracted_fact_id, corrected_value, updated_at")
    .in(
      "extracted_fact_id",
      facts.map((f) => f.id),
    )
    .eq("status", "confirmed");

  if (confError) {
    throw confError;
  }

  const confirmations = (confRows ?? []) as Array<{
    extracted_fact_id: string;
    corrected_value: string | null;
    updated_at?: string | null;
  }>;

  const corrected = new Map<string, string | null>(
    confirmations.map((r) => [r.extracted_fact_id, r.corrected_value]),
  );

  let latestConfirmationAt: string | null = null;
  for (const c of confirmations) {
    if (typeof c.updated_at === "string" && (latestConfirmationAt === null || c.updated_at > latestConfirmationAt)) {
      latestConfirmationAt = c.updated_at;
    }
  }

  return {
    facts: facts
      .filter((f) => corrected.has(f.id))
      .map((f) => ({ type: f.fact_type, value: corrected.get(f.id) || f.fact_value })),
    latestConfirmationAt,
  };
}

/**
 * Returns the JD snapshot for the vacancy's most recent raw version,
 * creating it (deterministic per-adapter extraction) if it does not exist.
 * `null` when the provider payload carries no usable JD text — no snapshot
 * row is written in that case.
 */
async function getOrCreateJdSnapshot(
  client: SupabaseClient,
  vacancy: VacancyRow,
): Promise<{ id: string; cleanText: string; sectionHeadings: string[] } | null> {
  const { data: versionRow, error: versionError } = await client
    .from("vacancy_versions")
    .select("id, raw_payload")
    .eq("vacancy_id", vacancy.id)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (versionError) {
    throw versionError;
  }
  if (!versionRow) {
    return null;
  }

  const version = versionRow as { id: string; raw_payload: unknown };

  const { data: existing, error: existingError } = await client
    .from("vacancy_jd_snapshots")
    .select("id, clean_text, sections")
    .eq("vacancy_version_id", version.id)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }
  if (existing) {
    const row = existing as { id: string; clean_text: string; sections: Array<{ heading: string | null }> };
    return {
      id: row.id,
      cleanText: row.clean_text,
      sectionHeadings: (row.sections ?? []).map((s) => s.heading).filter((h): h is string => !!h),
    };
  }

  const extraction = extractJd(vacancy.source_code, version.raw_payload);
  if (extraction.cleanText.trim() === "") {
    return null;
  }

  const { data: inserted, error: insertError } = await client
    .from("vacancy_jd_snapshots")
    .insert({
      vacancy_id: vacancy.id,
      vacancy_version_id: version.id,
      canonical_url: extraction.canonicalUrl ?? "",
      clean_text: extraction.cleanText,
      sections: extraction.sections,
      html_snapshot: extraction.htmlSnapshot,
      source_code: vacancy.source_code,
      extractor_version: JD_EXTRACTOR_VERSION,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw insertError ?? new Error("vacancy_jd_snapshots insert returned no row.");
  }

  return {
    id: (inserted as { id: string }).id,
    cleanText: extraction.cleanText,
    sectionHeadings: extraction.sections.map((s) => s.heading).filter((h): h is string => !!h),
  };
}

/** PostgREST returns a to-one embed as an object and a to-many as an array. */
function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Latest vacancy_trust_scores.score — the company_credibility factor.
 * Readable only by the service role, which is exactly why priority scoring
 * had to move server-side. null when never scored, or scored without a
 * numeric result (a hard-block short-circuit).
 */
async function loadLatestTrustScore(client: SupabaseClient, vacancyId: string): Promise<number | null> {
  const { data, error } = await client
    .from("vacancy_trust_scores")
    .select("score")
    .eq("vacancy_id", vacancyId)
    .order("scored_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const score = (data as { score: number | null } | null)?.score;
  return typeof score === "number" ? score : null;
}

interface ApplicationSignal {
  /** An application_plans row exists for this pair — the "Submitted" stage floor. */
  hasApplication: boolean;
  /** Latest response_classifications.category on any message linked to this application. */
  responseCategory: ResponseCategory | null;
  /** That classification's extracted_deadline, if any. */
  deadline: string | null;
}

interface ClassificationEmbed {
  category: string | null;
  classified_at: string;
  extracted_deadline: string | null;
}

/**
 * The response_stage inputs (25% — the heaviest factor), reached in one
 * query: application_plans is unique per (candidate, vacancy), so its
 * presence is `hasApplication`, and the classification for the pair hangs
 * off it through application_attempts -> messages.
 */
async function loadApplicationSignal(
  client: SupabaseClient,
  candidateId: string,
  vacancyId: string,
): Promise<ApplicationSignal> {
  const { data, error } = await client
    .from("application_plans")
    .select("id, application_attempts(messages(response_classifications(category, classified_at, extracted_deadline)))")
    .eq("candidate_id", candidateId)
    .eq("vacancy_id", vacancyId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    return { hasApplication: false, responseCategory: null, deadline: null };
  }

  const plan = data as {
    application_attempts?: unknown;
  };

  const classifications = asArray(plan.application_attempts as Array<{ messages?: unknown }> | null)
    .flatMap((attempt) => asArray(attempt.messages as Array<{ response_classifications?: unknown }> | null))
    .flatMap((message) => asArray(message.response_classifications as ClassificationEmbed[] | null))
    .filter((c): c is ClassificationEmbed => !!c && typeof c.classified_at === "string");

  classifications.sort((a, b) => b.classified_at.localeCompare(a.classified_at));
  const latest = classifications[0];

  return {
    hasApplication: true,
    responseCategory: latest && isResponseCategory(latest.category) ? latest.category : null,
    deadline: latest?.extracted_deadline ?? null,
  };
}

/**
 * Mirrors server/applications/eligibilityGate.ts evaluateRoleMatch: a plain
 * case-insensitive substring comparison, since no normalized role taxonomy
 * exists in this repository. null when the candidate has selected no roles
 * — that is an absent preference signal, not a failed match.
 */
async function loadRoleMatch(
  client: SupabaseClient,
  candidateId: string,
  vacancyTitle: string,
): Promise<boolean | null> {
  const { data, error } = await client
    .from("candidate_selected_roles")
    .select("role_name")
    .eq("candidate_id", candidateId);

  if (error) {
    throw error;
  }

  const roles = ((data ?? []) as Array<{ role_name: string }>).map((r) => r.role_name);
  if (roles.length === 0) {
    return null;
  }

  const title = vacancyTitle.toLowerCase();
  return roles.some((role) => {
    const normalized = role.trim().toLowerCase();
    return normalized.length > 0 && title.includes(normalized);
  });
}

interface ExistingAnalysisRow {
  jd_snapshot_id: string | null;
  analyzed_at: string;
  technical_fit_score: number | null;
  technical_fit_components: FitAnalysisRow["technical_fit_components"];
  missing_evidence: string[] | null;
  top_reasons: string[] | null;
  risks: string[] | null;
  model_version: string;
  prompt_version: string;
}

async function loadExistingAnalysis(
  client: SupabaseClient,
  candidateId: string,
  vacancyId: string,
): Promise<ExistingAnalysisRow | null> {
  const { data, error } = await client
    .from("fit_analyses")
    .select(
      "jd_snapshot_id, analyzed_at, technical_fit_score, technical_fit_components, missing_evidence, top_reasons, risks, model_version, prompt_version",
    )
    .eq("candidate_id", candidateId)
    .eq("vacancy_id", vacancyId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as ExistingAnalysisRow | null) ?? null;
}

export async function analyzeFit(
  client: SupabaseClient,
  deps: AnalyzeFitDeps,
  target: { candidateId: string; vacancyId: string },
): Promise<FitAnalysisRow> {
  const { candidateId, vacancyId } = target;

  const { data: vacancyData, error: vacancyError } = await client
    .from("vacancies")
    .select(
      "id, raw_title, source_code, country, region, city, remote_type, salary_min, salary_max, salary_source, expires_at",
    )
    .eq("id", vacancyId)
    .maybeSingle();

  if (vacancyError) {
    throw vacancyError;
  }
  if (!vacancyData) {
    throw new FitAnalysisTargetError(`Vacancy ${vacancyId} not found.`);
  }
  const vacancy = vacancyData as VacancyRow;

  const { facts, latestConfirmationAt } = await loadConfirmedFacts(client, candidateId);
  const locationFact = facts.find((f) => f.type === "location")?.value ?? null;

  const eligInput: PracticalEligibilityInput = {
    candidateLocation: locationFact,
    vacancy: {
      country: vacancy.country,
      region: vacancy.region,
      city: vacancy.city,
      remoteType: vacancy.remote_type,
    },
  };
  const elig = evaluatePracticalEligibility(eligInput);

  // v1: hard_blockers is location-only, soft_penalties is always empty (its
  // codes are all reserved). Informational states (INSUFFICIENT_DATA when
  // practical_eligibility_score is null; LOCATION_UNKNOWN when a non-remote
  // vacancy has no country) are derivable by consumers and not persisted.
  const capped = elig.hardBlockers.length > 0;

  const snapshot = await getOrCreateJdSnapshot(client, vacancy);
  const existing = await loadExistingAnalysis(client, candidateId, vacancyId);

  let technicalFitScore: number | null = null;
  let technicalFitComponents: FitAnalysisRow["technical_fit_components"] = null;
  let missingEvidence: string[] = [];
  let topReasons: string[] = [];
  let risks: string[] = [];
  let modelVersion =
    process.env.FIT_ANALYSIS_MODEL ?? process.env.OPENAI_MODEL ?? process.env.OPENROUTER_MODEL ?? DEFAULT_FIT_MODEL;

  // Phase 2.3b AI-skip guard. The re-enqueue mesh re-runs this analysis
  // whenever response stage, trust bucket or selected roles change — none of
  // which are Technical Fit inputs. Re-paying for an identical AI call on
  // every recruiter email would make the mesh unaffordable, so reuse the
  // stored Technical Fit when all three of its inputs are provably
  // unchanged: same JD snapshot, no confirmation newer than the last
  // analysis, and the same prompt version (a prompt bump must re-run).
  // Practical Eligibility and the priority score are pure and always
  // recomputed. model_version is carried over with the reused output so the
  // row keeps reporting which model actually produced it.
  const canReuseTechnicalFit =
    snapshot !== null &&
    existing !== null &&
    existing.jd_snapshot_id === snapshot.id &&
    existing.technical_fit_score !== null &&
    existing.prompt_version === FIT_ANALYSIS_PROMPT_VERSION &&
    (latestConfirmationAt === null || latestConfirmationAt <= existing.analyzed_at);

  if (snapshot && canReuseTechnicalFit && existing) {
    technicalFitScore = existing.technical_fit_score;
    technicalFitComponents = existing.technical_fit_components;
    missingEvidence = existing.missing_evidence ?? [];
    topReasons = existing.top_reasons ?? [];
    risks = existing.risks ?? [];
    modelVersion = existing.model_version;
  } else if (snapshot) {
    const fit = await analyzeTechnicalFit(deps.openai, {
      jdText: snapshot.cleanText,
      sectionHeadings: snapshot.sectionHeadings,
      factLines: facts.map((f) => `${f.type}: ${f.value}`),
      roleTitle: vacancy.raw_title ?? "(unknown role)",
    });
    technicalFitScore = fit.overall;
    technicalFitComponents = fit.components;
    missingEvidence = fit.missing_evidence;
    topReasons = fit.top_reasons;
    risks = fit.risks;
  }

  const practicalEligibilityScore = capped ? 0 : elig.score;

  // §12.1 priority score (Phase 2.3b): all 8 factors, computed here because
  // company_credibility needs the service role's read on vacancy_trust_scores.
  const [trustScore, applicationSignal, roleMatch] = await Promise.all([
    loadLatestTrustScore(client, vacancyId),
    loadApplicationSignal(client, candidateId, vacancyId),
    loadRoleMatch(client, candidateId, vacancy.raw_title ?? ""),
  ]);

  const priority = computePriorityScore({
    technicalFitScore,
    practicalEligibilityScore,
    eligibilityCapped: capped,
    responseCategory: applicationSignal.responseCategory,
    hasApplication: applicationSignal.hasApplication,
    remoteType: vacancy.remote_type,
    salary: { min: vacancy.salary_min, max: vacancy.salary_max, source: vacancy.salary_source },
    // Snapshot urgency. Readers refresh this slice from expires_at via
    // finalizeWithFreshUrgency; the stored scalar is the sort key.
    deadlineDays: nearestDeadlineDays([vacancy.expires_at, applicationSignal.deadline]),
    roleMatch,
    companyCredibility: trustScore,
  });

  return {
    candidate_id: candidateId,
    vacancy_id: vacancyId,
    jd_snapshot_id: snapshot?.id ?? null,
    jd_text_available: snapshot !== null,
    technical_fit_score: technicalFitScore,
    technical_fit_components: technicalFitComponents,
    missing_evidence: missingEvidence,
    practical_eligibility_score: practicalEligibilityScore,
    hard_blockers: elig.hardBlockers,
    soft_penalties: elig.softPenalties,
    eligibility_capped: capped,
    top_reasons: topReasons,
    risks,
    model_version: modelVersion,
    prompt_version: FIT_ANALYSIS_PROMPT_VERSION,
    priority_score: priority.score,
    priority_uncapped_score: priority.uncappedScore,
    priority_components: priority.components,
    priority_score_version: priority.version,
  };
}
