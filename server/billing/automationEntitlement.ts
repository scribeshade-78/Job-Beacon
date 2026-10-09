import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_PLAN_CODE } from "../../shared/pricing.js";
import { LIVE_SUBSCRIPTION_STATUSES } from "./subscription.js";
import type { BillingInterval } from "./plans.js";

/**
 * The automation entitlement — "does this candidate's EFFECTIVE plan include a
 * non-zero auto-apply allowance?" and nothing else.
 *
 * WHY IT IS SEPARATE FROM evaluateEntitlements. That function answers the whole
 * PRD §27.2 matrix for the Billing UI, and its documented rule is that an
 * unconfigured dimension is PERMISSIVE. Applying that rule here would make a
 * Free candidate (no subscription row) entitled to automation, which is wrong:
 * the pricing catalogue seeds free = 0 auto-apply. Rather than change
 * evaluateEntitlements and risk the other ten dimensions, this loader resolves
 * the effective plan explicitly — the live subscription's plan, else
 * 'free' — and reads only the two auto-apply columns.
 *
 * DESTINATION-AGNOSTIC, DELIBERATELY. The allowance is per job destination
 * (India / US) and is not transferable, but candidate_entitlement_usage has no
 * destination split, so a per-destination gate is not yet expressible. Entitled
 * therefore means "either quota is greater than zero", which today makes Free
 * the only blocked plan. Per-destination enforcement is a Phase 3 follow-up for
 * when a real submission-capable adapter exists.
 *
 * THE QUOTA IS NOT YET A COUNTER. This checks only that the plan INCLUDES an
 * allowance; it does not check remaining/consumed usage. The monthly auto-apply
 * quota is not currently a real counter — enforcement of actual usage is a
 * Phase 3 prerequisite for real submission.
 *
 * Query errors THROW, matching every other billing/service read. The readiness
 * caller catches and fails closed; the eligibility gate propagates so an
 * operational failure is not reported as a plan problem.
 */

export interface AutomationEntitlement {
  /**
   * The plan INCLUDES an automation allowance for the current interval. Says
   * nothing about whether any of it is left — that is quotaExhausted, kept
   * separate so the two produce DIFFERENT reason codes rather than one vague
   * "not eligible" that a candidate cannot act on.
   */
  planEntitled: boolean;
  /** The plan the decision was made on: the live subscription's plan, or 'free'. */
  planCode: string;
  /** The allowance for the CURRENT billing interval, or 0 when the plan has none. */
  limit: number;
  /** Attempts consumed this billing period: every status except 'cancelled'. */
  consumed: number;
  /** True when the plan has an allowance and it is used up. */
  quotaExhausted: boolean;
  /** The interval the limit was read for, so a failure can say which one. */
  billingInterval: BillingInterval;
}

interface PlanLimitsRow {
  max_auto_apply_india_per_month: number | null;
  max_auto_apply_us_per_month: number | null;
  max_auto_apply_india_per_week: number | null;
  max_auto_apply_us_per_week: number | null;
}

/**
 * Attempts consumed this billing period, read through the SAME function the
 * billing matrix uses, so the gate and the number a candidate is shown cannot
 * disagree about what was spent.
 *
 * A read failure THROWS rather than returning zero. Defaulting to zero would
 * convert a database blip into an unmetered allowance, which is the wrong
 * direction to fail in for a quota.
 */
async function loadConsumedApplications(
  client: Pick<SupabaseClient, "rpc">,
  candidateId: string,
): Promise<number> {
  const { data, error } = await client.rpc("candidate_entitlement_usage", {
    p_candidate_id: candidateId,
  });

  if (error) {
    throw error;
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { consumed_applications_this_period?: number }
    | undefined;

  return row?.consumed_applications_this_period ?? 0;
}

export async function loadAutomationEntitlement(
  client: Pick<SupabaseClient, "from" | "rpc">,
  candidateId: string,
): Promise<AutomationEntitlement> {
  const { data: subscription, error: subscriptionError } = await client
    .from("subscriptions")
    .select("plan_id, billing_interval")
    .eq("candidate_id", candidateId)
    .in("status", [...LIVE_SUBSCRIPTION_STATUSES])
    .maybeSingle();

  if (subscriptionError) {
    throw subscriptionError;
  }

  // The interval the SUBSCRIPTION was bought at decides which limit column
  // applies. A weekly plan compared against a monthly allowance would be handed
  // roughly four times what it paid for.
  const billingInterval: BillingInterval =
    (subscription as { billing_interval?: BillingInterval } | null)?.billing_interval ?? "month";

  let planCode: string = DEFAULT_PLAN_CODE;
  let planId: string | null = null;

  if (subscription) {
    planId = (subscription as { plan_id: string }).plan_id;

    const { data: plan, error: planError } = await client
      .from("subscription_plans")
      .select("code")
      .eq("id", planId)
      .single();

    if (planError) {
      throw planError;
    }

    planCode = (plan as { code: string }).code;
  } else {
    // No subscription IS the Free plan (shared/pricing.ts DEFAULT_PLAN_CODE), so
    // the free row's zero allowance must actually be applied rather than read as
    // "no plan, therefore no limit".
    const { data: freePlan, error: freePlanError } = await client
      .from("subscription_plans")
      .select("id")
      .eq("code", DEFAULT_PLAN_CODE)
      .maybeSingle();

    if (freePlanError) {
      throw freePlanError;
    }

    planId = freePlan ? (freePlan as { id: string }).id : null;
  }

  if (planId === null) {
    return {
      planEntitled: false,
      planCode,
      limit: 0,
      consumed: 0,
      quotaExhausted: false,
      billingInterval,
    };
  }

  const { data: limits, error: limitsError } = await client
    .from("plan_limits")
    .select(
      "max_auto_apply_india_per_month, max_auto_apply_us_per_month, " +
        "max_auto_apply_india_per_week, max_auto_apply_us_per_week",
    )
    .eq("plan_id", planId)
    .maybeSingle();

  if (limitsError) {
    throw limitsError;
  }

  const row = (limits ?? null) as PlanLimitsRow | null;
  const weekly = billingInterval === "week";

  const india = weekly
    ? row?.max_auto_apply_india_per_week ?? null
    : row?.max_auto_apply_india_per_month ?? null;

  const us = weekly ? row?.max_auto_apply_us_per_week ?? null : row?.max_auto_apply_us_per_month ?? null;

  // MAX OF THE TWO, NOT THE SUM. candidate_entitlement_usage has no destination
  // split, so a per-destination gate is still not expressible (see this file's
  // header). The larger is the only defensible reading: the smaller would refuse a
  // US application against an India-only figure.
  const limit = Math.max(india ?? 0, us ?? 0);
  const consumed = await loadConsumedApplications(client, candidateId);

  return {
    planEntitled: limit > 0,
    planCode,
    limit,
    consumed,
    quotaExhausted: limit > 0 && consumed >= limit,
    billingInterval,
  };
}
