/**
 * Opportunity Intelligence Phase 2.2 — the §12.1 weighted Opportunity
 * Priority Score.
 *
 * Pure and versioned. Computed on read (client-side, from fields already on
 * fit_analyses) rather than persisted: 6 of the 8 §12.1 factors have no
 * data source yet and are held at a neutral 50, so the composite is ~75%
 * placeholder — persisting a versioned placeholder would mean a full
 * fit-worker re-run on every tweak. Promote to a stored, versioned column
 * (the trustScore.ts pattern) once ≥1 more real factor lands.
 *
 * Shared so a future server-side persister can import the identical rule.
 */

export const PRIORITY_SCORE_VERSION = "priority-v1";

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
}

export interface PriorityFactorComponent {
  weight: number;
  /** The 0-100 value fed into the weighted sum (pre-cap). */
  value: number;
  /** "fit" = a real fit_analyses score; "neutral" = the 50 placeholder. */
  source: "fit" | "neutral";
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

  const factorValue: Record<PriorityFactor, number> = {
    response_stage: NEUTRAL_FACTOR_VALUE,
    practical_eligibility: input.practicalEligibilityScore ?? NEUTRAL_FACTOR_VALUE,
    technical_fit: input.technicalFitScore ?? NEUTRAL_FACTOR_VALUE,
    employment_arrangement: NEUTRAL_FACTOR_VALUE,
    compensation_quality: NEUTRAL_FACTOR_VALUE,
    company_credibility: NEUTRAL_FACTOR_VALUE,
    urgency: NEUTRAL_FACTOR_VALUE,
    user_preferences: NEUTRAL_FACTOR_VALUE,
  };

  const realFactor: Partial<Record<PriorityFactor, boolean>> = {
    practical_eligibility: input.practicalEligibilityScore !== null,
    technical_fit: input.technicalFitScore !== null,
  };

  const components = {} as Record<PriorityFactor, PriorityFactorComponent>;
  let weighted = 0;

  for (const factor of Object.keys(FACTOR_WEIGHTS) as PriorityFactor[]) {
    const weight = FACTOR_WEIGHTS[factor];
    const value = clamp(factorValue[factor], 0, 100);
    components[factor] = { weight, value, source: realFactor[factor] ? "fit" : "neutral" };
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
