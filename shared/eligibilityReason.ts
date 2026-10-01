/**
 * Candidate-facing copy for the eligibility gates (server/applications/eligibilityGate.ts).
 *
 * WHY IT LIVES IN shared/. The reasonCodes are stored in
 * application_plans.gate_results and read by two audiences: the Copilot's
 * blocked-outcome summary (server/agent/tools.ts) and the Applications page,
 * which has to say why a plan never reached "In Progress". Two copies of this
 * table would drift, so both import this one.
 *
 * WHY NOT THE RAW CODE. "NO_ADAPTER_REGISTERED_FOR_SOURCE" is accurate and
 * useless to a job seeker. The code still travels in the structured data for
 * logs and support; only the copy a person reads is translated. An unrecognised
 * code falls back to a generic sentence rather than leaking the identifier.
 */

/** Plain-language clause per gate reasonCode. Keyed lookup, order-independent. */
export const GATE_REASON_CLAUSES: Record<string, string> = {
  NO_ADAPTER_REGISTERED_FOR_SOURCE: "automatic applications aren't available for this job's site yet",
  SOURCE_APPLICATION_NOT_AUTHORIZED: "this job's site isn't authorized for automatic applications",
  AUTOMATION_NOT_AUTHORIZED: "automatic applications are paused on your account",
  VACANCY_TRUST_STATUS_INELIGIBLE: "we haven't finished checking this job posting",
  ROLE_NOT_MATCHED: "this job doesn't match the roles you selected",
  NO_ROLES_SELECTED: "you haven't selected any target roles yet",
  NO_FACTS_EXTRACTED: "you haven't confirmed any profile facts yet",
  NO_FACTS_CONFIRMED: "you haven't confirmed any profile facts yet",
  DAILY_APPLICATION_LIMIT_EXCEEDED: "you've hit today's application limit",
  DUPLICATE_APPLICATION_EXISTS: "you've already applied to this job",

  // Phase 1 Task 5 — the feed's SearchPreferences ledger. Same vocabulary as the
  // application gates so one ineligibilityReasonOf renders both.
  role_mismatch: "this job doesn't match the roles you selected",
  excluded_company: "you've excluded this company",
  excluded_industry: "you've excluded this industry",
  work_mode_mismatch: "this job's work mode doesn't match what you're looking for",
  below_min_salary: "the advertised salary is below your minimum",
  location_not_stated: "you haven't told us where you want to work yet",
  location_mismatch: "this job is outside the locations you chose",
  plan_not_eligible: "your current plan does not include automatic applications",
};

export const GENERIC_INELIGIBLE_REASON = "it didn't pass our eligibility checks";

/** Structural view of one stored gate result — matches GateResult without importing server code. */
export interface StoredGateResult {
  status?: string;
  reasonCode?: string;
}

export type StoredGates = Record<string, StoredGateResult | null | undefined>;

/**
 * The order a reason is drawn from when several gates fail. The first nine
 * mirror EligibilityGates' declaration order; the last three are the feed
 * ledger's own gates (Phase 1 Task 5). Most fundamental, candidate-fixable
 * checks first, so the sentence points at the first thing worth doing.
 */
export const GATE_PRECEDENCE = [
  "source_policy",
  "vacancy_trust",
  "automation_authorization",
  "candidate_exclusions",
  "idempotency",
  "role_match",
  "verified_facts",
  "application_support",
  "rate_and_abuse_controls",
  // The feed ledger's own gates (Phase 1 Task 5). "role_match" is shared with
  // the application gate above; these three exist only in the feed ledger, and
  // are listed so ineligibilityReasonOf can render it.
  "excluded_company",
  "excluded_industry",
  "work_mode",
  "salary",
  "location",
  "plan_entitlement",
] as const;

/**
 * The sentence for why a plan is not eligible.
 *
 * Reads the FIRST failing gate in GATE_PRECEDENCE and translates its
 * reasonCode. A gate that failed without a recognised code, or gates that are
 * missing entirely, fall back to the generic sentence — never to a raw token.
 */
export function ineligibilityReasonOf(gates: StoredGates | null | undefined): string {
  if (!gates) {
    return GENERIC_INELIGIBLE_REASON;
  }

  for (const name of GATE_PRECEDENCE) {
    const gate = gates[name];

    if (!gate || gate.status !== "fail") {
      continue;
    }

    const code = typeof gate.reasonCode === "string" ? gate.reasonCode : null;

    return (code !== null && GATE_REASON_CLAUSES[code]) || GENERIC_INELIGIBLE_REASON;
  }

  return GENERIC_INELIGIBLE_REASON;
}
