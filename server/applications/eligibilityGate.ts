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
 * Rate and abuse controls, Idempotency). R4.2 wired 5 of those against
 * real repository data; R4.5 added `role_match` as a 6th (candidate_selected_roles,
 * PRD §9.1); R4.6 adds `verified_facts` as a 7th, now that
 * extracted_facts/fact_confirmations (PRD §21.1 Resume domain) exist — a
 * coarse presence check (at least one confirmed fact), not yet matched
 * against which facts a given vacancy actually requires, since no
 * vacancy-side fact-requirement data exists yet either. The remaining 2
 * are still permanent hard-block placeholders until their prerequisite
 * systems exist: `application_support` needs a channel/adapter capability
 * model (PRD §16.2); `rate_and_abuse_controls` needs a rate-limiting
 * system (the same class of gap R3.7 documented for report
 * rate-limiting). Neither exists anywhere in this repository.
 */
export interface EligibilityGates {
  source_policy: GateResult;
  vacancy_trust: GateResult;
  automation_authorization: GateResult;
  candidate_exclusions: GateResult;
  idempotency: GateResult;
  role_match: GateResult;
  verified_facts: GateResult;
  application_support: GateResult;
  rate_and_abuse_controls: GateResult;
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

/**
 * Every application_attempts.status except 'failed' — a failed attempt is
 * the safe-to-retry case PRD §16.1's "no prior successful or active
 * application" wording carves out. Exported so applicationEngine.ts (R4.3)
 * reuses this exact domain rule instead of redefining it — the same
 * blocking-statuses question ("is there already active work on this
 * plan") arises both when deciding whether *planning* should proceed
 * here, and whether *creating a new attempt* should proceed there.
 */
export const ACTIVE_ATTEMPT_STATUSES = new Set(["pending", "leased", "succeeded", "action_required"]);

export async function evaluateEligibilityGates(
  client: SupabaseClient,
  input: EvaluateEligibilityGatesInput,
): Promise<EligibilityGateOutcome> {
  const { candidateId, vacancyId } = input;

  const { data: vacancyRow, error: vacancyError } = await client
    .from("vacancies")
    .select("source_code, trust_status, raw_title")
    .eq("id", vacancyId)
    .maybeSingle();

  if (vacancyError) {
    throw vacancyError;
  }
  if (!vacancyRow) {
    throw new Error(`vacancies row not found for id ${vacancyId}`);
  }

  const vacancy = vacancyRow as { source_code: string; trust_status: string | null; raw_title: string };

  const [
    sourcePolicyGate,
    automationAuthorizationGate,
    candidateExclusionsGate,
    idempotencyGate,
    roleMatchGate,
    verifiedFactsGate,
  ] = await Promise.all([
    evaluateSourcePolicy(client, vacancy.source_code),
    evaluateAutomationAuthorization(client, candidateId),
    evaluateCandidateExclusions(client, candidateId),
    evaluateIdempotency(client, candidateId, vacancyId),
    evaluateRoleMatch(client, candidateId, vacancy.raw_title),
    evaluateVerifiedFacts(client, candidateId),
  ]);

  const gates: EligibilityGates = {
    source_policy: sourcePolicyGate,
    vacancy_trust: evaluateVacancyTrust(vacancy.trust_status),
    automation_authorization: automationAuthorizationGate,
    candidate_exclusions: candidateExclusionsGate,
    idempotency: idempotencyGate,
    role_match: roleMatchGate,
    verified_facts: verifiedFactsGate,
    // Permanent hard-block placeholders (approved R4 sequencing decision):
    // no channel/adapter capability model exists
    // (PRD §16.2 — which portal fields and attachments a given source
    // actually supports), and no rate/abuse-limiting system exists
    // anywhere in this repository (the same class of gap R3.7 documented
    // for candidate report rate-limiting).
    application_support: { status: "fail", reasonCode: "APPLICATION_SUPPORT_NOT_IMPLEMENTED" },
    rate_and_abuse_controls: { status: "fail", reasonCode: "RATE_CONTROLS_NOT_IMPLEMENTED" },
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
 * R4.5 minimal role taxonomy (PRD §9.1): no normalized vacancy role
 * taxonomy or NLP/ML matching exists in this repository, so this is
 * deliberately a plain case-insensitive substring comparison between each
 * of the candidate's free-text candidate_selected_roles.role_name values
 * and vacancies.raw_title — an exact match is just the substring-equals-
 * whole-string case, so no separate exact-match branch is needed. Empty or
 * whitespace-only role names are skipped rather than matched, since
 * `"".includes("")` would otherwise make a blank role name match every
 * vacancy title.
 */
async function evaluateRoleMatch(
  client: SupabaseClient,
  candidateId: string,
  vacancyTitle: string,
): Promise<GateResult> {
  const { data, error } = await client
    .from("candidate_selected_roles")
    .select("role_name")
    .eq("candidate_id", candidateId);

  if (error) {
    throw error;
  }

  const selectedRoles = ((data ?? []) as Array<{ role_name: string }>).map((row) => row.role_name);

  if (selectedRoles.length === 0) {
    return { status: "fail", reasonCode: "NO_ROLES_SELECTED" };
  }

  const normalizedTitle = vacancyTitle.toLowerCase();

  const matchedRole = selectedRoles.find((role) => {
    const normalizedRole = role.trim().toLowerCase();
    return normalizedRole.length > 0 && normalizedTitle.includes(normalizedRole);
  });

  if (matchedRole) {
    return { status: "pass", detail: { matchedRole } };
  }

  return { status: "fail", reasonCode: "ROLE_NOT_MATCHED", detail: { selectedRoles } };
}

/**
 * R4.6 minimal fact verification (PRD §21.1 Resume domain): no
 * fact-extraction pipeline exists yet, so this is a coarse presence
 * check — at least one of the candidate's extracted_facts has a
 * 'confirmed' fact_confirmations row — not yet matched against which
 * facts a given vacancy actually requires (deferred, same "no
 * normalized taxonomy on the other side yet" reasoning as role_match,
 * until vacancy-side requirement data exists). Two-step query (facts,
 * then confirmations for those fact ids) mirrors evaluateIdempotency's
 * own shape rather than a single embedded-filter query, matching this
 * file's existing style.
 */
async function evaluateVerifiedFacts(client: SupabaseClient, candidateId: string): Promise<GateResult> {
  const { data: factRows, error: factError } = await client
    .from("extracted_facts")
    .select("id")
    .eq("candidate_id", candidateId);

  if (factError) {
    throw factError;
  }

  const factIds = ((factRows ?? []) as Array<{ id: string }>).map((row) => row.id);

  if (factIds.length === 0) {
    return { status: "fail", reasonCode: "NO_FACTS_EXTRACTED" };
  }

  const { data: confirmationRows, error: confirmationError } = await client
    .from("fact_confirmations")
    .select("status")
    .in("extracted_fact_id", factIds);

  if (confirmationError) {
    throw confirmationError;
  }

  const hasConfirmedFact = ((confirmationRows ?? []) as Array<{ status: string }>).some(
    (row) => row.status === "confirmed",
  );

  if (hasConfirmedFact) {
    return { status: "pass" };
  }

  return { status: "fail", reasonCode: "NO_FACTS_CONFIRMED" };
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
