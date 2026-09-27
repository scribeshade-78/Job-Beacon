import type { SupabaseClient } from "@supabase/supabase-js";
import { getCandidateSubscription } from "./subscription.js";
import type { PlanLimits } from "./plans.js";

/**
 * Task H1 — evaluating the PRD v3 §27.2 plan limits.
 *
 * THIS IS NOT A SAFETY GATE, AND MUST NEVER BECOME ONE. PRD v3 §27.3 is
 * explicit: "Commercial entitlements never override source rate limits, trust
 * blocks, candidate eligibility, legal restrictions or safety controls." This
 * module therefore sits ADDITIONALLY alongside server/applications/
 * eligibilityGate.ts and can only ever subtract from what a candidate may do,
 * never add. Nothing here may be consulted to decide whether a vacancy is
 * trustworthy, whether a source permits automation, or whether a candidate is
 * eligible — those answers come from the eligibility gates and nowhere else.
 *
 * NULL MEANS NOT CONFIGURED, AND NOT CONFIGURED IS PERMISSIVE. No source
 * document specifies a numeric limit for any of these dimensions, so every
 * column in plan_limits is nullable and every seeded plan currently holds NULL.
 * The alternative - treating NULL as zero - would have blocked the entire
 * product the moment this table was created, which is precisely backwards:
 * an unconfigured commercial limit is an absent commercial promise, not a
 * prohibition.
 *
 * §27.3 ALSO FORBIDS CALLING THAT "UNLIMITED". An application allowance is
 * always bounded by source rate limits, trust blocks and eligibility whatever
 * the plan says, so labelling an unconfigured dimension "Unlimited" would
 * promise a candidate something the system cannot deliver. The UI renders the
 * word "Not configured" and this type carries the configured flag that forces
 * that distinction to be handled rather than collapsed into a boolean.
 */

export type EntitlementKind = "count" | "capability" | "depth";

export interface EntitlementDimensionSpec {
  id: string;
  /** The §27.2 bullet this dimension comes from, quoted as the PRD writes it. */
  prdLabel: string;
  kind: EntitlementKind;
}

/**
 * The §27.2 bullets, mapped to the columns that store them.
 *
 * ELEVEN entries now. Nine came from the eight §27.2 bullets, where the eighth
 * bullet ("Historical analytics and exports") names two separable capabilities
 * joined by "and" and therefore occupies two columns — the only way a plan can
 * grant analytics history without also granting exports. The remaining two are
 * the destination auto-apply quotas, which the product states per destination
 * and which §27.2's single "verified applications per month" bullet cannot
 * express.
 */
export const ENTITLEMENT_DIMENSIONS: readonly EntitlementDimensionSpec[] = [
  { id: "active_target_roles", prdLabel: "Active target roles", kind: "count" },
  { id: "verified_applications_per_month", prdLabel: "Verified applications per month", kind: "count" },
  // The one allowance the product states per DESTINATION rather than per
  // candidate. Two entries, not one, because a single number cannot express
  // "30 for India, 80 for the US".
  { id: "auto_apply_india_per_month", prdLabel: "Auto-apply, India jobs (per month)", kind: "count" },
  { id: "auto_apply_us_per_month", prdLabel: "Auto-apply, US jobs (per month)", kind: "count" },
  { id: "premium_source_access", prdLabel: "Premium source access", kind: "capability" },
  { id: "ats_resume_variants", prdLabel: "ATS resume variants", kind: "count" },
  { id: "mailbox_connections", prdLabel: "Mailbox connections", kind: "count" },
  { id: "company_intelligence_depth", prdLabel: "Company intelligence depth", kind: "depth" },
  { id: "priority_action_required_support", prdLabel: "Priority action-required support", kind: "capability" },
  { id: "analytics_history_days", prdLabel: "Historical analytics and exports", kind: "count" },
  { id: "data_exports_enabled", prdLabel: "Historical analytics and exports", kind: "capability" },
];

export interface EntitlementEvaluation {
  dimension: string;
  prdLabel: string;
  kind: EntitlementKind;
  /** False when no value is stored for this dimension. See the module comment: permissive, but never called unlimited. */
  configured: boolean;
  /** Always true when not configured. */
  allowed: boolean;
  limit: number | boolean | string | null;
  usage: number | null;
  /** Only for a configured countable dimension; null otherwise. */
  remaining: number | null;
}

export interface EntitlementSummary {
  hasLiveSubscription: boolean;
  planCode: string | null;
  planDisplayName: string | null;
  evaluations: EntitlementEvaluation[];
  /** True when nothing at all is configured — the honest starting state for every plan shipped by this phase. */
  allUnconfigured: boolean;
}

interface UsageRow {
  active_target_roles: number;
  verified_applications_this_month: number;
  ats_resume_variants: number;
  connected_mailboxes: number;
}

const USAGE_BY_DIMENSION: Record<string, keyof UsageRow> = {
  active_target_roles: "active_target_roles",
  verified_applications_per_month: "verified_applications_this_month",
  ats_resume_variants: "ats_resume_variants",
  mailbox_connections: "connected_mailboxes",
};

const LIMIT_BY_DIMENSION: Record<string, keyof PlanLimits> = {
  active_target_roles: "maxActiveTargetRoles",
  verified_applications_per_month: "maxVerifiedApplicationsPerMonth",
  auto_apply_india_per_month: "maxAutoApplyIndiaPerMonth",
  auto_apply_us_per_month: "maxAutoApplyUsPerMonth",
  premium_source_access: "premiumSourceAccess",
  ats_resume_variants: "maxAtsResumeVariants",
  mailbox_connections: "maxMailboxConnections",
  company_intelligence_depth: "companyIntelligenceDepth",
  priority_action_required_support: "priorityActionRequiredSupport",
  analytics_history_days: "analyticsHistoryDays",
  data_exports_enabled: "dataExportsEnabled",
};

/** Zeroed usage for a candidate who has never done anything, so evaluation never depends on a missing row. */
const ZERO_USAGE: UsageRow = {
  active_target_roles: 0,
  verified_applications_this_month: 0,
  ats_resume_variants: 0,
  connected_mailboxes: 0,
};

async function loadUsage(client: SupabaseClient, candidateId: string): Promise<UsageRow> {
  const { data, error } = await client.rpc("candidate_entitlement_usage", { p_candidate_id: candidateId });

  if (error) {
    throw error;
  }

  const row = (Array.isArray(data) ? data[0] : data) as UsageRow | undefined;

  return row ?? ZERO_USAGE;
}

/**
 * Evaluates every §27.2 dimension for one candidate.
 *
 * Usage is counted even when nothing is configured, because the admin console
 * has to be able to show a founder what a candidate is actually consuming
 * BEFORE they decide what the limits should be. A limit-setting screen that
 * hides current usage is a screen nobody can make a decision from.
 */
export async function evaluateEntitlements(
  client: SupabaseClient,
  candidateId: string,
): Promise<EntitlementSummary> {
  const subscription = await getCandidateSubscription(client, candidateId);
  const usage = await loadUsage(client, candidateId);

  let limits: PlanLimits | null = null;

  if (subscription) {
    const { data: plan, error } = await client
      .from("subscription_plans")
      .select("id")
      .eq("code", subscription.planCode)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (plan) {
      const { data: limitRow, error: limitError } = await client
        .from("plan_limits")
        .select("*")
        .eq("plan_id", (plan as { id: string }).id)
        .maybeSingle();

      if (limitError) {
        throw limitError;
      }

      if (limitRow) {
        const row = limitRow as Record<string, unknown>;
        limits = {
          maxActiveTargetRoles: row.max_active_target_roles as number | null,
          maxVerifiedApplicationsPerMonth: row.max_verified_applications_per_month as number | null,
          premiumSourceAccess: row.premium_source_access as boolean | null,
          maxAtsResumeVariants: row.max_ats_resume_variants as number | null,
          maxMailboxConnections: row.max_mailbox_connections as number | null,
          companyIntelligenceDepth: row.company_intelligence_depth as PlanLimits["companyIntelligenceDepth"],
          priorityActionRequiredSupport: row.priority_action_required_support as boolean | null,
          analyticsHistoryDays: row.analytics_history_days as number | null,
          dataExportsEnabled: row.data_exports_enabled as boolean | null,
          maxAutoApplyIndiaPerMonth: row.max_auto_apply_india_per_month as number | null,
          maxAutoApplyUsPerMonth: row.max_auto_apply_us_per_month as number | null,
        };
      }
    }
  }

  const evaluations = ENTITLEMENT_DIMENSIONS.map((spec) => evaluateDimension(spec, limits, usage));

  return {
    hasLiveSubscription: subscription !== null,
    planCode: subscription?.planCode ?? null,
    planDisplayName: subscription?.planDisplayName ?? null,
    evaluations,
    allUnconfigured: evaluations.every((evaluation) => !evaluation.configured),
  };
}

function evaluateDimension(
  spec: EntitlementDimensionSpec,
  limits: PlanLimits | null,
  usage: UsageRow,
): EntitlementEvaluation {
  const limitKey = LIMIT_BY_DIMENSION[spec.id];
  const limit = limits && limitKey ? limits[limitKey] : null;
  const usageKey = USAGE_BY_DIMENSION[spec.id];
  const used = usageKey ? usage[usageKey] : null;

  if (limit === null || limit === undefined) {
    return {
      dimension: spec.id,
      prdLabel: spec.prdLabel,
      kind: spec.kind,
      configured: false,
      allowed: true,
      limit: null,
      usage: used,
      remaining: null,
    };
  }

  if (spec.kind === "count" && typeof limit === "number") {
    // A configured allowance whose usage is not measured. Reporting 0 here would
    // dress a unknown up as a fact, so usage and remaining stay null and
    // `allowed` answers the narrower question the data can support: does this
    // plan include the allowance at all? The two destination auto-apply quotas
    // are in this state because candidate_entitlement_usage counts applications
    // globally and has no destination split yet. Give them a USAGE_BY_DIMENSION
    // entry once it does, and this branch stops applying to them.
    if (usageKey === undefined) {
      return {
        dimension: spec.id,
        prdLabel: spec.prdLabel,
        kind: spec.kind,
        configured: true,
        allowed: limit > 0,
        limit,
        usage: null,
        remaining: null,
      };
    }

    const current = used ?? 0;
    return {
      dimension: spec.id,
      prdLabel: spec.prdLabel,
      kind: spec.kind,
      configured: true,
      allowed: current < limit,
      limit,
      usage: current,
      remaining: Math.max(0, limit - current),
    };
  }

  if (spec.kind === "depth" && typeof limit === "string") {
    // "none" is the only depth that withholds anything; "basic" and "full" both
    // grant access, so the depth's value is stored and displayed rather than
    // collapsed to a yes/no here.
    return {
      dimension: spec.id,
      prdLabel: spec.prdLabel,
      kind: spec.kind,
      configured: true,
      allowed: limit !== "none",
      limit,
      usage: null,
      remaining: null,
    };
  }

  const capability = limit === true;
  return {
    dimension: spec.id,
    prdLabel: spec.prdLabel,
    kind: spec.kind,
    configured: true,
    allowed: capability,
    limit: capability,
    usage: null,
    remaining: null,
  };
}
