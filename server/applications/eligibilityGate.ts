import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveApplicationAdapter } from "./adapters/registry.js";
import {
  evaluateSearchPreferenceEligibility,
  type SearchPreferences,
} from "../../shared/searchPreferences.js";
import { isTitleRelevantToRole } from "../../shared/roleTaxonomy.js";
import { loadSearchPreferencesForCandidate } from "./searchPreferences.js";
import { evaluateDismissal } from "./dismissalGate.js";
import { loadPreferredQualifiers } from "./preferredQualifiers.js";
import { loadAutomationEntitlement } from "../billing/automationEntitlement.js";

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
 * PRD §9.1); R4.6 added `verified_facts` as a 7th, now that
 * extracted_facts/fact_confirmations (PRD §21.1 Resume domain) exist — a
 * coarse presence check (at least one confirmed fact), not yet matched
 * against which facts a given vacancy actually requires, since no
 * vacancy-side fact-requirement data exists yet either. R7-M2 (R4.8) wires
 * `application_support` as an 8th: it now checks whether
 * resolveApplicationAdapter (PRD §23.2's runtime capability check) has a
 * real adapter for the vacancy's source_code, rather than unconditionally
 * failing. It still fails for every vacancy in production today, but NOT
 * because no adapter exists: greenhouse, lever and local_fixture all have
 * real adapters (see adapters/registry.ts). It fails because no source that
 * holds vacancies has BOTH an adapter AND a source_policies row with
 * automated_application_allowed = true — the two halves this gate and
 * evaluateSourcePolicy check independently. It will start passing, with no
 * further gate changes, once one source satisfies both. See
 * queueCapability.ts, which answers that same question once for the whole
 * system so the Copilot does not offer an action that cannot succeed.
 * `rate_and_abuse_controls` was a permanent hard-block placeholder until
 * R7-M9, which wired it as a pure mirror of the `automation_authorization`
 * gate — PRD §31 had left candidate application-limit policy as an
 * explicit open founder decision, and the founder's R7-M1 answer at the
 * time was pause/stop-only, no numeric quota. MP-RC1 supersedes that
 * specific "no numeric quota" stance with an explicit founder decision to
 * add one: `evaluateRateAndAbuseControls` now independently enforces
 * MAX_DAILY_APPLICATIONS_PER_CANDIDATE over a rolling window, querying
 * application_attempts directly rather than deriving from
 * automation_authorization. `automation_authorization` remains its own,
 * separate gate below (pause/stop enforcement is unaffected by this
 * change) — this gate is now a second, genuinely independent check
 * alongside it, not instead of it.
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
  /**
   * The candidate's own per-vacancy dismissal (dismissed_vacancies). Dismissal
   * beats a save row, so this is checked as its own gate rather than folded
   * into candidate_exclusions — those are global categories, not a listing.
   */
  dismissed: GateResult;
  /**
   * ADVISORY ONLY — this always passes.
   *
   * The candidate's raw-phrase preferences ("Azure preferred") rank otherwise
   * relevant postings and never gate anything. It occupies a gate-shaped slot so
   * the explanation travels in the same ledger as every other reason, and its
   * detail carries the label the UI shows. A request naming a preference we have
   * no evidence for is still eligible, by construction.
   */
  preferred_qualifiers: GateResult;
  /**
   * SearchPreferences gates (Phase 1 Task 6). OPTIONAL because application_plans
   * rows written before this shipped have no such keys; the gate always writes
   * them going forward, and ineligibilityReasonOf already ignores absent gates.
   */
  excluded_company?: GateResult;
  excluded_industry?: GateResult;
  work_mode?: GateResult;
  salary?: GateResult;
  location?: GateResult;
  plan_entitlement?: GateResult;
}

export interface EligibilityGateOutcome {
  eligible: boolean;
  gates: EligibilityGates;
}

export interface EvaluateEligibilityGatesInput {
  candidateId: string;
  vacancyId: string;
}

/** Exported so runner.ts (MP-W1) queries the same eligible-trust-status set this gate checks, instead of redefining it. */
export const VACANCY_TRUST_ELIGIBLE_STATUSES = new Set(["VERIFIED", "VERIFIED_INCOMPLETE"]);

/**
 * Every application_attempts.status except 'failed' — a failed attempt is
 * the safe-to-retry case PRD §16.1's "no prior successful or active
 * application" wording carves out. Exported so applicationEngine.ts (R4.3)
 * reuses this exact domain rule instead of redefining it — the same
 * blocking-statuses question ("is there already active work on this
 * plan") arises both when deciding whether *planning* should proceed
 * here, and whether *creating a new attempt* should proceed there.
 */
export const ACTIVE_ATTEMPT_STATUSES = new Set([
  "pending",
  // Task U: a held attempt is live work. Leaving it out would let
  // planApplication create a second, immediately-claimable attempt beside one
  // sitting in the review queue — routing around the gate it just applied.
  "pending_review",
  "leased",
  "succeeded",
  "action_required",
]);

export async function evaluateEligibilityGates(
  client: SupabaseClient,
  input: EvaluateEligibilityGatesInput,
): Promise<EligibilityGateOutcome> {
  const { candidateId, vacancyId } = input;

  const { data: vacancyRow, error: vacancyError } = await client
    .from("vacancies")
    .select("source_code, trust_status, raw_title, company_id, country, city, remote_type, salary_max, currency")
    .eq("id", vacancyId)
    .maybeSingle();

  if (vacancyError) {
    throw vacancyError;
  }
  if (!vacancyRow) {
    throw new Error(`vacancies row not found for id ${vacancyId}`);
  }

  const vacancy = vacancyRow as {
    source_code: string;
    trust_status: string | null;
    raw_title: string;
    company_id: string | null;
    country: string | null;
    city: string | null;
    remote_type: string | null;
    salary_max: number | null;
    currency: string | null;
  };

  const [
    sourcePolicyGate,
    automationAuthorizationGate,
    candidateExclusionsGate,
    idempotencyGate,
    verifiedFactsGate,
    rateAndAbuseControlsGate,
    searchPreferences,
    companyResult,
    companyProfileResult,
    automationEntitlement,
    dismissalGate,
    preferredQualifierSummary,
  ] = await Promise.all([
    evaluateSourcePolicy(client, vacancy.source_code),
    evaluateAutomationAuthorization(client, candidateId),
    evaluateCandidateExclusions(client, candidateId),
    evaluateIdempotency(client, candidateId, vacancyId),
    evaluateVerifiedFacts(client, candidateId),
    evaluateRateAndAbuseControls(client, candidateId),
    // THE SERVER LOADS THE PREFERENCES ITSELF, from the authenticated candidate
    // id. Nothing in the request body can influence them.
    loadSearchPreferencesForCandidate(client, candidateId),
    vacancy.company_id === null
      ? Promise.resolve({ data: null, error: null })
      : client.from("companies").select("displayed_name").eq("id", vacancy.company_id).maybeSingle(),
    vacancy.company_id === null
      ? Promise.resolve({ data: null, error: null })
      : client
          .from("company_profiles")
          .select("industry")
          .eq("company_id", vacancy.company_id)
          .maybeSingle(),
    // The plan entitlement is loaded from the candidate's own rows, never from
    // the request.
    loadAutomationEntitlement(client, candidateId),
    evaluateDismissal(client, candidateId, vacancyId),
    loadPreferredQualifiers(client, candidateId),
  ]);

  if (companyResult.error) {
    throw companyResult.error;
  }
  if (companyProfileResult.error) {
    throw companyProfileResult.error;
  }

  const companyName = (companyResult.data as { displayed_name: string } | null)?.displayed_name ?? null;
  const industry = (companyProfileResult.data as { industry: string | null } | null)?.industry ?? null;

  const preferenceLedger = evaluateSearchPreferenceEligibility(searchPreferences, {
    title: vacancy.raw_title,
    companyName,
    industry,
    remoteType: vacancy.remote_type,
    country: vacancy.country,
    city: vacancy.city,
    salary: { max: vacancy.salary_max, currency: vacancy.currency },
  });

  const gates: EligibilityGates = {
    source_policy: sourcePolicyGate,
    vacancy_trust: evaluateVacancyTrust(vacancy.trust_status),
    automation_authorization: automationAuthorizationGate,
    candidate_exclusions: candidateExclusionsGate,
    idempotency: idempotencyGate,
    // role_match keeps its own codes and matchedRole detail (Phase 0 decision),
    // but now matches with the shared tokenized matcher rather than a substring.
    role_match: evaluateRoleMatch(searchPreferences, vacancy.raw_title),
    verified_facts: verifiedFactsGate,
    application_support: evaluateApplicationSupport(vacancy, candidateId),
    rate_and_abuse_controls: rateAndAbuseControlsGate,
    dismissed: dismissalGate,
    preferred_qualifiers: {
      status: "pass",
      detail: {
        qualifiers: preferredQualifierSummary.qualifiers,
        label: preferredQualifierSummary.label,
      },
    },
    excluded_company: preferenceLedger.gates.excluded_company,
    excluded_industry: preferenceLedger.gates.excluded_industry,
    work_mode: preferenceLedger.gates.work_mode,
    salary: preferenceLedger.gates.salary,
    location: preferenceLedger.gates.location,
    plan_entitlement: automationEntitlement.planEntitled
      ? { status: "pass" }
      : {
          status: "fail",
          reasonCode: "plan_not_eligible",
          detail: { planCode: automationEntitlement.planCode },
        },
  };

  const eligible = Object.values(gates).every((gate) => gate.status === "pass");

  return { eligible, gates };
}

/**
 * PRD §16.1's "application support" gate ("Portal fields and attachments
 * are supported") / §23.2's runtime capability check, R7-M2, wired to the
 * adapter's own capability model by MP-A1: no vacancy-side portal-field/
 * attachment taxonomy exists in this repository (the same "nothing on the
 * other side to compare against yet" gap role_match and verified_facts
 * already document), so this cannot yet check *which* fields a source
 * supports, only *whether* it's supported at all. Resolves the adapter for
 * this vacancy's source_code and asks it directly via validateSupport() —
 * the adapter is the single source of truth for its own capability, so
 * this gate no longer identity-compares against the unsupportedAdapter
 * singleton (MP-A1 replaces that ad hoc check with the real interface
 * method it existed ahead of). Reason code defaults to
 * NO_ADAPTER_REGISTERED_FOR_SOURCE — unchanged from R7-M2 — when an
 * adapter doesn't supply its own; unsupportedAdapter always supplies that
 * exact code today, so behavior is identical to before this change for
 * every real source_code, which still has no registered adapter.
 */
function evaluateApplicationSupport(
  vacancy: { source_code: string; trust_status: string | null; raw_title: string },
  candidateId: string,
): GateResult {
  const adapter = resolveApplicationAdapter(vacancy.source_code);
  const validation = adapter.validateSupport({
    vacancy: { sourceCode: vacancy.source_code, trustStatus: vacancy.trust_status, rawTitle: vacancy.raw_title },
    candidateId,
  });

  if (!validation.supported) {
    return {
      status: "fail",
      reasonCode: validation.reasonCode ?? "NO_ADAPTER_REGISTERED_FOR_SOURCE",
      detail: { sourceCode: vacancy.source_code },
    };
  }

  return { status: "pass", detail: { adapter: adapter.sourceCode } };
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

/** MP-RC1: founder-set daily submission cap and its rolling window — see EligibilityGates' doc comment for why this supersedes R7-M1's "no numeric quota" stance. */
const MAX_DAILY_APPLICATIONS_PER_CANDIDATE = 25;
const RATE_LIMIT_WINDOW_HOURS = 24;

/**
 * 'cancelled' (R7-M4: the candidate paused/stopped automation before
 * submission ever reached a portal — nothing was actually attempted) is
 * the only status excluded from the velocity count. Every other status —
 * including 'failed' — still represents a real attempt that was made,
 * which is what a rate/abuse control is meant to bound.
 */
const ATTEMPT_STATUSES_COUNTED_TOWARD_RATE_LIMIT = [
  "pending",
  // Task U: a held attempt is an application the candidate has queued and
  // intends to send, so it counts against the daily cap exactly like a
  // claimable one. Excluding it would make the review queue a way to hold
  // unlimited applications in flight, which is the opposite of what a velocity
  // control is for.
  "pending_review",
  "leased",
  "succeeded",
  "failed",
  "action_required",
];

/**
 * MP-RC1 (PRD §16.1 Gate 7, §31): a genuinely independent numeric velocity
 * check, no longer derived from automation_authorization (see
 * EligibilityGates' doc comment for the R7-M1 -> MP-RC1 history).
 * application_attempts carries no candidate_id column of its own (only
 * reachable via application_plans.candidate_id — see that table's
 * migration), so this is a two-hop query: every plan id this candidate
 * has, then every counted-status attempt on those plans created within
 * the rolling window. Same "plan -> attempts" shape as evaluateIdempotency,
 * widened from one plan to all of this candidate's plans. The status and
 * time-window filters run server-side (not fetched-then-filtered in JS)
 * so this stays a single bounded query regardless of the candidate's total
 * history size.
 */
async function evaluateRateAndAbuseControls(client: SupabaseClient, candidateId: string): Promise<GateResult> {
  const { data: planRows, error: planError } = await client
    .from("application_plans")
    .select("id")
    .eq("candidate_id", candidateId);

  if (planError) {
    throw planError;
  }

  const planIds = ((planRows ?? []) as Array<{ id: string }>).map((row) => row.id);

  if (planIds.length === 0) {
    return { status: "pass", detail: { count: 0, limit: MAX_DAILY_APPLICATIONS_PER_CANDIDATE } };
  }

  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const { data: attemptRows, error: attemptError } = await client
    .from("application_attempts")
    .select("id")
    .in("application_plan_id", planIds)
    .in("status", ATTEMPT_STATUSES_COUNTED_TOWARD_RATE_LIMIT)
    .gte("created_at", windowStart);

  if (attemptError) {
    throw attemptError;
  }

  const count = (attemptRows ?? []).length;

  if (count >= MAX_DAILY_APPLICATIONS_PER_CANDIDATE) {
    return {
      status: "fail",
      reasonCode: "DAILY_APPLICATION_LIMIT_EXCEEDED",
      detail: { count, limit: MAX_DAILY_APPLICATIONS_PER_CANDIDATE, windowHours: RATE_LIMIT_WINDOW_HOURS },
    };
  }

  return { status: "pass", detail: { count, limit: MAX_DAILY_APPLICATIONS_PER_CANDIDATE } };
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
 * Whether the vacancy's title is relevant to ANY of the candidate's saved target
 * roles — the tokenized matcher from shared/roleTaxonomy.ts, the same one the
 * Target Roles search and the feed filter use.
 *
 * WHY IT IS NOT A SUBSTRING CHECK ANY MORE. The old rule was
 * title.includes(role), which passed "Metadata Analyst" for the role "Data
 * Analyst" — the role's letters happened to be contiguous inside a different
 * word. The shared matcher requires every token of the role to match a word of
 * the title, so that case now fails.
 *
 * THE CODES AND THE matchedRole DETAIL ARE UNCHANGED (Phase 0 decision): an
 * empty role list is NO_ROLES_SELECTED, no match is ROLE_NOT_MATCHED with the
 * saved roles as evidence, and a match names the role that satisfied it.
 */
function evaluateRoleMatch(preferences: SearchPreferences, vacancyTitle: string): GateResult {
  const selectedRoles = preferences.targetRoles;

  if (selectedRoles.length === 0) {
    return { status: "fail", reasonCode: "NO_ROLES_SELECTED" };
  }

  const matchedRole = selectedRoles.find((role) => isTitleRelevantToRole(vacancyTitle, role));

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
