/**
 * Response Intelligence Phase 2.1 — stable reason codes for Practical
 * Eligibility (Opportunity Intelligence PRD §11.3). Same "frozen const map,
 * SCREAMING_SNAKE keys, one human description each" shape as
 * server/trust/positiveReasonCodes.ts.
 *
 * Every trust/eligibility decision in JobBeacon must be explainable through
 * stable reason codes (product invariant). These codes are the contract:
 * consumers (the 2.2 UI, pgTAP, the weighted priority score) key off them,
 * so a code's meaning never changes once shipped.
 *
 * The AI (server/opportunities/fitPrompt.ts) never emits a reason code — it
 * emits free-text `risks[]`. Only the deterministic rules engine
 * (practicalEligibility.ts) emits codes.
 */

/** Hard blockers (§11.3) — presence caps practical_eligibility_score to 0. */
export const HARD_BLOCKER_CODES = {
  /** Non-remote role, candidate not present in the required country. v1: emitted. */
  LOCATION_PRESENCE: "Non-remote role in a country the candidate is not located in.",
  /**
   * JD requires work authorisation the candidate cannot satisfy (unless
   * India contractor/EOR). RESERVED — not emitted until extracted_facts
   * carries a work-authorisation fact.
   */
  WORK_AUTHORISATION: "Work authorisation required that the candidate does not hold.",
  /**
   * JD states US-employee / US-payroll only. RESERVED — not emitted until
   * JD-clause detection exists.
   */
  PAYROLL_COUNTRY_US_ONLY: "Role is US-payroll / US-employee only.",
  /**
   * JD requires an active security clearance. RESERVED — not emitted until
   * JD-clause detection exists.
   */
  SECURITY_CLEARANCE: "Active security clearance required.",
} as const;

/** Soft penalties (§11.3) — reduce the score, never cap it. All RESERVED in v1. */
export const SOFT_PENALTY_CODES = {
  /** JD indicates a night-shift schedule. RESERVED — no deterministic source in v1. */
  SCHEDULE_NIGHT_SHIFT: "Role is a night-shift schedule.",
  /** Candidate below a stated experience / certification bar. RESERVED — no deterministic source in v1. */
  EXPERIENCE_CERTIFICATION: "Candidate below a stated experience or certification requirement.",
} as const;

/** Informational — not a blocker, not a penalty; explains a null/!full score. */
export const INFO_CODES = {
  /** Vacancy has no country data, so location eligibility could not be evaluated. */
  LOCATION_UNKNOWN: "Vacancy location unknown; location eligibility not evaluated.",
  /** Candidate has no confirmed location fact, so Practical Eligibility is null. */
  INSUFFICIENT_DATA: "Not enough confirmed candidate data to evaluate eligibility.",
} as const;

export type HardBlockerCode = keyof typeof HARD_BLOCKER_CODES;
export type SoftPenaltyCode = keyof typeof SOFT_PENALTY_CODES;
export type InfoCode = keyof typeof INFO_CODES;

export interface ReasonEntry {
  code: HardBlockerCode | SoftPenaltyCode | InfoCode;
  detail: string;
}
