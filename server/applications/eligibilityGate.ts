import type { SupabaseClient } from "@supabase/supabase-js";

export type GateStatus = "pass" | "fail";

export interface GateResult {
  status: GateStatus;
  reasonCode?: string;
  detail?: Record<string, unknown>;
}

/**
 * PRD §16.1 names 8 gates (Source policy, Vacancy trust, Candidate
 * eligibility, Verified facts, Application support, Consent and privacy,
 * Rate and abuse controls, Idempotency). This mini-phase (R4 sequencing
 * decision, approved) wires exactly 5 of those against real repository
 * data plus 2 permanent hard-block placeholders — 7 keys total.
 * `application_support` (needs a channel/adapter capability model that
 * doesn't exist) and `rate_and_abuse_controls` (needs a rate-limiting
 * system, the same class of gap R3.7 documented for report rate-limiting)
 * are NOT included here — that's a scope boundary, not an oversight.
 */
export interface EligibilityGates {
  source_policy: GateResult;
  vacancy_trust: GateResult;
  automation_authorization: GateResult;
  candidate_exclusions: GateResult;
  idempotency: GateResult;
  role_match: GateResult;
  verified_facts: GateResult;
}

export interface EligibilityGateOutcome {
  eligible: boolean;
  gates: EligibilityGates;
}

export interface EvaluateEligibilityGatesInput {
  candidateId: string;
  vacancyId: string;
}

const VACANCY_TRUST_ELIGIBLE_STATUSES = new Set(["VERIFIED", "VERIFIED_INCOMPLETE"]);

/** Every application_attempts.status except 'failed' — a failed attempt is the safe-to-retry case PRD §16.1's "no prior successful or active application" wording carves out. */
const ACTIVE_ATTEMPT_STATUSES = new Set(["pending", "leased", "succeeded", "action_required"]);

export async function evaluateEligibilityGates(
  client: SupabaseClient,
  input: EvaluateEligibilityGatesInput,
): Promise<EligibilityGateOutcome> {
  const { candidateId, vacancyId } = input;

  const { data: vacancyRow, error: vacancyError } = await client
    .from("vacancies")
    .select("source_code, trust_status")
    .eq("id", vacancyId)
    .maybeSingle();

  if (vacancyError) {
    throw vacancyError;
  }
  if (!vacancyRow) {
    throw new Error(`vacancies row not found for id ${vacancyId}`);
  }

  const vacancy = vacancyRow as { source_code: string; trust_status: string | null };

  const [sourcePolicyGate, automationAuthorizationGate, candidateExclusionsGate, idempotencyGate] =
    await Promise.all([
      evaluateSourcePolicy(client, vacancy.source_code),
      evaluateAutomationAuthorization(client, candidateId),
      evaluateCandidateExclusions(client, candidateId),
      evaluateIdempotency(client, candidateId, vacancyId),
    ]);

  const gates: EligibilityGates = {
    source_policy: sourcePolicyGate,
    vacancy_trust: evaluateVacancyTrust(vacancy.trust_status),
    automation_authorization: automationAuthorizationGate,
    candidate_exclusions: candidateExclusionsGate,
    idempotency: idempotencyGate,
    // Permanent hard-block placeholders (approved R4 sequencing decision):
    // candidate_selected_roles/role taxonomy (PRD §9.1) and
    // extracted_facts/fact_confirmations (PRD §21.1 Resume domain) don't
    // exist anywhere in this repository, so these two gates can never
    // pass until those systems are built in a later R4 mini-phase.
    role_match: { status: "fail", reasonCode: "ROLE_TAXONOMY_NOT_IMPLEMENTED" },
    verified_facts: { status: "fail", reasonCode: "FACT_VERIFICATION_NOT_IMPLEMENTED" },
  };

  const eligible = Object.values(gates).every((gate) => gate.status === "pass");

  return { eligible, gates };
}

function evaluateVacancyTrust(trustStatus: string | null): GateResult {
  if (trustStatus !== null && VACANCY_TRUST_ELIGIBLE_STATUSES.has(trustStatus)) {
    return { status: "pass" };
  }
  return {
    status: "fail",
    reasonCode: "VACANCY_TRUST_STATUS_INELIGIBLE",
    detail: { trustStatus },
  };
}

async function evaluateSourcePolicy(client: SupabaseClient, sourceCode: string): Promise<GateResult> {
  const { data, error } = await client
    .from("source_policies")
    .select("discovery_allowed, automated_application_allowed")
    .eq("source_code", sourceCode)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const policy = data as { discovery_allowed: boolean; automated_application_allowed: boolean } | null;

  if (policy?.discovery_allowed && policy.automated_application_allowed) {
    return { status: "pass" };
  }

  return {
    status: "fail",
    reasonCode: "SOURCE_APPLICATION_NOT_AUTHORIZED",
    detail: {
      discoveryAllowed: policy?.discovery_allowed ?? false,
      automatedApplicationAllowed: policy?.automated_application_allowed ?? false,
    },
  };
}

async function evaluateAutomationAuthorization(client: SupabaseClient, candidateId: string): Promise<GateResult> {
  const { data, error } = await client
    .from("automation_authorizations")
    .select("status")
    .eq("candidate_id", candidateId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const authorization = data as { status: string } | null;

  if (authorization?.status === "authorized") {
    return { status: "pass" };
  }

  return {
    status: "fail",
    reasonCode: "AUTOMATION_NOT_AUTHORIZED",
    detail: { status: authorization?.status ?? "not_yet_authorized" },
  };
}

/**
 * PRD §9.2's global exclusions (candidate_exclusions, R1) are real,
 * queried data — but vacancies (§11.2) carries no category classification
 * matching candidate_exclusions' categories (staffing_agencies,
 * contract_roles, relocation_required, sensitive_sectors); that
 * vacancy-side taxonomy doesn't exist anywhere in this repository. Until
 * it does, this gate always passes: a real query against real candidate
 * data, honestly nothing on the vacancy side to compare it against yet —
 * not a fabricated check. excludedCategories is recorded in `detail` so
 * the moment vacancy-side classification lands, only the comparison logic
 * needs to be added here, not a new data source.
 */
async function evaluateCandidateExclusions(client: SupabaseClient, candidateId: string): Promise<GateResult> {
  const { data, error } = await client
    .from("candidate_exclusions")
    .select("category")
    .eq("candidate_id", candidateId);

  if (error) {
    throw error;
  }

  const excludedCategories = ((data ?? []) as Array<{ category: string }>).map((row) => row.category);

  return { status: "pass", detail: { excludedCategories } };
}

/**
 * PRD §16.1/§21.2: "No prior successful or active application exists for
 * the same canonical vacancy." application_plans' own
 * UNIQUE(candidate_id, vacancy_id) constraint (R4.1) stops a second plan
 * row outright, but this gate runs *before* a plan is created, to decide
 * whether creating one is even allowed — so it looks up any existing
 * plan's attempts directly instead of relying on the insert to fail.
 */
async function evaluateIdempotency(
  client: SupabaseClient,
  candidateId: string,
  vacancyId: string,
): Promise<GateResult> {
  const { data: planRow, error: planError } = await client
    .from("application_plans")
    .select("id")
    .eq("candidate_id", candidateId)
    .eq("vacancy_id", vacancyId)
    .maybeSingle();

  if (planError) {
    throw planError;
  }
  if (!planRow) {
    return { status: "pass" };
  }

  const applicationPlanId = (planRow as { id: string }).id;

  const { data: attempts, error: attemptsError } = await client
    .from("application_attempts")
    .select("status")
    .eq("application_plan_id", applicationPlanId);

  if (attemptsError) {
    throw attemptsError;
  }

  const blockingAttempt = ((attempts ?? []) as Array<{ status: string }>).find((attempt) =>
    ACTIVE_ATTEMPT_STATUSES.has(attempt.status),
  );

  if (blockingAttempt) {
    return {
      status: "fail",
      reasonCode: "DUPLICATE_APPLICATION_EXISTS",
      detail: { applicationPlanId, blockingStatus: blockingAttempt.status },
    };
  }

  return { status: "pass" };
}
