/**
 * Opportunity Intelligence Phase 2.2 / 2.3a / 2.3b — the §12.1 weighted
 * Opportunity Priority Score.
 *
 * Pure and versioned. As of 2.3b this runs SERVER-SIDE in
 * server/opportunities/analyzeFit.ts and its result is stored on
 * fit_analyses (priority_score / priority_uncapped_score /
 * priority_components / priority_score_version). All 8 factors now read
 * real data when it exists — company_credibility became reachable once the
 * computation moved to the service-role client, which (unlike the
 * candidate's browser role) can read vacancy_trust_scores.
 *
 * Storage is kept honest by two mechanisms:
 *   * a re-enqueue mesh (20260901050010_fit_enqueue_mesh + the broadened
 *     guard in server/trust/scoreVacancy.ts) re-runs the analysis when
 *     response stage, trust bucket, or selected roles change;
 *   * urgency — the one factor that decays daily with no data change at
 *     all, so no trigger can ever cover it — is refreshed by the READER
 *     via finalizeWithFreshUrgency() below, re-summing the stored
 *     components with a freshly computed urgency slice. The stored scalar
 *     keeps its snapshot urgency and serves as the sort key.
 *
 * Still pure and side-effect free apart from daysUntil()/
 * nearestDeadlineDays(), which read the clock and are marked as such.
 */

export const PRIORITY_SCORE_VERSION = "priority-v3";

/**
 * Response-stage ordinal. Keys mirror the code-owned taxonomy in
 * server/mailbox/classifyMessage.ts (MESSAGE_CATEGORIES) — duplicated as a
 * literal union rather than imported to keep shared/ free of a server
 * dependency. `rejection` = 0 (dead), `other` = neutral (a real message
 * but not a stage signal), everything else ascends toward `offer` = 100.
 */
export type ResponseCategory =
  | "interview"
  | "rejection"
  | "offer"
  | "action_required"
  | "recruiter_followup"
  | "application_received"
  | "other";

const RESPONSE_STAGE_VALUE: Record<ResponseCategory, number> = {
  rejection: 0,
  other: 50,
  application_received: 45,
  recruiter_followup: 60,
  action_required: 70,
  interview: 85,
  offer: 100,
};

/** An application exists but no classified reply yet — "Submitted". */
const RESPONSE_STAGE_SUBMITTED = 40;

/** Runtime guard for a raw response_classifications.category string. */
export function isResponseCategory(value: string | null | undefined): value is ResponseCategory {
  return value != null && value in RESPONSE_STAGE_VALUE;
}

/** The value every not-yet-available factor is held at. */
export const NEUTRAL_FACTOR_VALUE = 50;

/** §12.1 factor weights. MUST sum to exactly 1.00 (guarded by a test). */
export const FACTOR_WEIGHTS = {
  response_stage: 0.25,
  practical_eligibility: 0.2,
  technical_fit: 0.2,
  employment_arrangement: 0.1,
  compensation_quality: 0.1,
  company_credibility: 0.05,
  urgency: 0.05,
  user_preferences: 0.05,
} as const;

export type PriorityFactor = keyof typeof FACTOR_WEIGHTS;

export interface PriorityScoreInput {
  /** fit_analyses.technical_fit_score — null when jd_text_available is false. */
  technicalFitScore: number | null;
  /** fit_analyses.practical_eligibility_score — null on INSUFFICIENT_DATA. */
  practicalEligibilityScore: number | null;
  /** fit_analyses.eligibility_capped — a hard blocker forces the score to 0. */
  eligibilityCapped: boolean;

  // --- Phase 2.3a real signals. Every field optional; absent/null => the
  // factor is held at NEUTRAL_FACTOR_VALUE with source "neutral". ---

  /** Latest response_classifications.category for this candidate x vacancy. */
  responseCategory?: ResponseCategory | null;
  /** An application_plans row exists for this pair (applied, maybe no reply yet). */
  hasApplication?: boolean;
  /** vacancies.remote_type. */
  remoteType?: "remote" | "hybrid" | "on_site" | null;
  /** vacancies compensation fields — labels kept, never blended into one figure. */
  salary?: {
    min: number | null;
    max: number | null;
    source: "employer_disclosed" | "estimated" | null;
  } | null;
  /**
   * Whole days from today to the nearest of extracted_deadline / expires_at.
   * Negative (already past) is treated as no signal. null => none known.
   */
  deadlineDays?: number | null;
  /**
   * true / false when the candidate has selected roles and one does / does
   * not substring-match the title; null when they've selected no roles.
   */
  roleMatch?: boolean | null;
  /**
   * Latest vacancy_trust_scores.score (already 0-100, see
   * server/trust/trustScore.ts). Readable only by the service role, so this
   * is populated server-side in analyzeFit.ts. null when the vacancy has
   * never been scored, or was hard-blocked without a numeric result.
   */
  companyCredibility?: number | null;
}

export interface PriorityFactorComponent {
  weight: number;
  /** The 0-100 value fed into the weighted sum (pre-cap). */
  value: number;
  /** "fit" = derived from a real signal; "neutral" = the 50 placeholder. */
  source: "fit" | "neutral";
}

type Resolved = { value: number; real: boolean };
const NEUTRAL: Resolved = { value: NEUTRAL_FACTOR_VALUE, real: false };

function resolveResponseStage(input: PriorityScoreInput): Resolved {
  if (input.responseCategory != null) {
    return { value: RESPONSE_STAGE_VALUE[input.responseCategory], real: true };
  }
  if (input.hasApplication) {
    return { value: RESPONSE_STAGE_SUBMITTED, real: true };
  }
  return NEUTRAL;
}

function resolveEmploymentArrangement(remoteType: PriorityScoreInput["remoteType"]): Resolved {
  switch (remoteType) {
    case "remote":
      return { value: 100, real: true };
    case "hybrid":
      return { value: 70, real: true };
    case "on_site":
      return { value: 40, real: true };
    default:
      return NEUTRAL;
  }
}

function resolveCompensationQuality(salary: PriorityScoreInput["salary"]): Resolved {
  if (!salary || (salary.min == null && salary.max == null)) {
    // Absence of a salary is not a negative signal — stay neutral.
    return NEUTRAL;
  }
  if (salary.source === "employer_disclosed") {
    const hasRange = salary.min != null && salary.max != null && salary.min !== salary.max;
    return { value: hasRange ? 90 : 70, real: true };
  }
  // "estimated" or unlabelled: a figure exists but it is not employer-stated.
  return { value: 50, real: true };
}

function resolveUrgency(deadlineDays: PriorityScoreInput["deadlineDays"]): Resolved {
  if (deadlineDays == null || deadlineDays < 0) {
    return NEUTRAL;
  }
  if (deadlineDays <= 3) return { value: 100, real: true };
  if (deadlineDays <= 7) return { value: 85, real: true };
  if (deadlineDays <= 14) return { value: 70, real: true };
  if (deadlineDays <= 30) return { value: 55, real: true };
  return { value: 45, real: true };
}

function resolveUserPreferences(roleMatch: PriorityScoreInput["roleMatch"]): Resolved {
  if (roleMatch == null) {
    return NEUTRAL;
  }
  return { value: roleMatch ? 100 : 50, real: true };
}

/**
 * vacancy_trust_scores.score is already the 0-100 weighted trust result
 * (80+ VERIFIED / 50-79 UNDER_REVIEW / below 50 FLAGGED), so it feeds the
 * factor directly rather than being re-scaled — re-scaling would invent a
 * second, undocumented credibility curve on top of the trust policy's.
 */
function resolveCompanyCredibility(score: PriorityScoreInput["companyCredibility"]): Resolved {
  if (score == null) {
    return NEUTRAL;
  }
  return { value: clamp(score, 0, 100), real: true };
}

const DAY_MS = 86_400_000;

/** Whole days from now to `iso`; null when absent or unparseable. Reads the clock. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / DAY_MS);
}

/** Nearest (soonest) deadline in days across the given ISO timestamps. Reads the clock. */
export function nearestDeadlineDays(isos: Array<string | null | undefined>): number | null {
  const days = isos.map(daysUntil).filter((n): n is number => n !== null);
  return days.length > 0 ? Math.min(...days) : null;
}

/**
 * Re-sums a STORED priority_components breakdown with a freshly computed
 * urgency slice, returning the uncapped 0-100 scalar. The caller applies
 * the hard-blocker cap (score 0) itself.
 *
 * This is the reader half of the 2.3b storage design: every other factor
 * is refreshed by a re-enqueue hook, but urgency decays with the calendar
 * alone, so the stored value for it goes stale within a day of being
 * written. Everything else in `components` is used exactly as stored.
 *
 * Weights come from the stored components rather than FACTOR_WEIGHTS so an
 * older row is re-summed with the weights it was actually scored under.
 * Callers must still gate on priority_score_version matching before
 * trusting a stored breakdown at all.
 */
export function finalizeWithFreshUrgency(
  components: Record<PriorityFactor, PriorityFactorComponent>,
  deadlineDays: number | null,
): number {
  const freshUrgency = resolveUrgency(deadlineDays);

  let weighted = 0;
  for (const factor of Object.keys(FACTOR_WEIGHTS) as PriorityFactor[]) {
    const stored = components[factor];
    const weight = stored?.weight ?? FACTOR_WEIGHTS[factor];
    const value = factor === "urgency" ? freshUrgency.value : stored?.value ?? NEUTRAL_FACTOR_VALUE;
    weighted += weight * clamp(value, 0, 100);
  }

  return clamp(Math.round(weighted), 0, 100);
}

export interface PriorityScore {
  /** 0-100. 0 when eligibilityCapped. null when there is no fit analysis at all. */
  score: number | null;
  /** The weighted score before the hard-blocker cap. null when no fit analysis. */
  uncappedScore: number | null;
  capped: boolean;
  /** Per-factor breakdown (pre-cap values), for the "would have scored N" UI. null when no fit analysis. */
  components: Record<PriorityFactor, PriorityFactorComponent> | null;
  version: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * `null` input = no fit_analyses row for this (candidate, vacancy) yet
 * (worker hasn't run, or the candidate isn't authorised so nothing was
 * enqueued). Returns an all-null score — the UI shows "analysis pending".
 */
export function computePriorityScore(input: PriorityScoreInput | null): PriorityScore {
  if (!input) {
    return { score: null, uncappedScore: null, capped: false, components: null, version: PRIORITY_SCORE_VERSION };
  }

  const resolved: Record<PriorityFactor, Resolved> = {
    response_stage: resolveResponseStage(input),
    practical_eligibility: {
      value: input.practicalEligibilityScore ?? NEUTRAL_FACTOR_VALUE,
      real: input.practicalEligibilityScore !== null,
    },
    technical_fit: {
      value: input.technicalFitScore ?? NEUTRAL_FACTOR_VALUE,
      real: input.technicalFitScore !== null,
    },
    employment_arrangement: resolveEmploymentArrangement(input.remoteType),
    compensation_quality: resolveCompensationQuality(input.salary),
    company_credibility: resolveCompanyCredibility(input.companyCredibility),
    urgency: resolveUrgency(input.deadlineDays),
    user_preferences: resolveUserPreferences(input.roleMatch),
  };

  const components = {} as Record<PriorityFactor, PriorityFactorComponent>;
  let weighted = 0;

  for (const factor of Object.keys(FACTOR_WEIGHTS) as PriorityFactor[]) {
    const weight = FACTOR_WEIGHTS[factor];
    const value = clamp(resolved[factor].value, 0, 100);
    components[factor] = { weight, value, source: resolved[factor].real ? "fit" : "neutral" };
    weighted += weight * value;
  }

  const uncappedScore = clamp(Math.round(weighted), 0, 100);

  return {
    score: input.eligibilityCapped ? 0 : uncappedScore,
    uncappedScore,
    capped: input.eligibilityCapped,
    components,
    version: PRIORITY_SCORE_VERSION,
  };
}
