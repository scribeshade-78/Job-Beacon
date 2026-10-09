import type { SupabaseClient } from "@supabase/supabase-js";
import { listPlans, type BillingInterval, type PlanLimits } from "../billing/plans.js";

/**
 * Task H1 — the data behind the admin "Users & Billing" section.
 *
 * This module exists because that section used to be UsersBillingMock: three
 * invented email addresses and a hardcoded MRR figure, badged as mock. Nothing
 * here is invented. Every number is a count or a sum over rows that exist, and
 * where a number CANNOT be computed honestly it is not computed at all - see the
 * MRR note below.
 *
 * MRR IS REPORTED PER CURRENCY AND NEVER BLENDED. Summing INR, USD and EUR into
 * one figure requires an exchange rate, and this repository has no rate source
 * (salary_benchmarks stores an analytical_currency column precisely because the
 * same problem was hit there, and it is populated from a supplied value, not
 * from a live feed). A single blended total would therefore be a number no
 * source supports, displayed on the screen a founder uses to judge revenue -
 * the worst possible place for an invented figure. Three separate totals are
 * less convenient and are true.
 *
 * Annual prices are normalised to a monthly figure by dividing by twelve, which
 * is arithmetic on a stored amount rather than an assumption about anything.
 */

/** Bounds the per-candidate usage calls below; see the note on candidateUsage. */
export const ADMIN_BILLING_CANDIDATE_LIMIT = 100;

export interface AdminBillingUsage {
  activeTargetRoles: number;
  /** Succeeded attempts this billing period — what the candidate got. */
  verifiedApplicationsThisPeriod: number;
  /** Every attempt except cancelled — what the quota compares against the limit. */
  consumedApplicationsThisPeriod: number;
  atsResumeVariants: number;
  connectedMailboxes: number;
}

export interface AdminBillingCandidate {
  candidateId: string;
  /** Null when the auth record has no address; never a placeholder. */
  email: string | null;
  planCode: string | null;
  planDisplayName: string | null;
  /** 'none' when the candidate has no live subscription. */
  status: string;
  region: string | null;
  currency: string | null;
  billingInterval: BillingInterval | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  monthlyRecurringRevenueMinor: number;
  usage: AdminBillingUsage;
}

export interface AdminCurrencyTotal {
  currency: string;
  monthlyRecurringRevenueMinor: number;
  payingCandidates: number;
}

export interface AdminPlanCount {
  planCode: string;
  planDisplayName: string;
  subscribers: number;
}

export interface AdminPriceRow {
  planCode: string;
  planDisplayName: string;
  region: string;
  currency: string;
  billingInterval: BillingInterval;
  amountMinor: number | null;
  isActive: boolean;
}

export interface AdminBilling {
  candidates: AdminBillingCandidate[];
  currencyTotals: AdminCurrencyTotal[];
  planCounts: AdminPlanCount[];
  prices: AdminPriceRow[];
  /** How many §27.2 limit values are actually set, across every plan. Drives the "not configured" banner. */
  configuredLimitValues: number;
  totalLimitValues: number;
  /** True when the candidate list was cut off by ADMIN_BILLING_CANDIDATE_LIMIT. */
  truncated: boolean;
}

const LIMIT_KEYS: Array<keyof PlanLimits> = [
  "maxActiveTargetRoles",
  "maxVerifiedApplicationsPerMonth",
  "premiumSourceAccess",
  "maxAtsResumeVariants",
  "maxMailboxConnections",
  "companyIntelligenceDepth",
  "priorityActionRequiredSupport",
  "analyticsHistoryDays",
  "dataExportsEnabled",
  "maxAutoApplyIndiaPerMonth",
  "maxAutoApplyUsPerMonth",
];

const ZERO_USAGE: AdminBillingUsage = {
  activeTargetRoles: 0,
  verifiedApplicationsThisPeriod: 0,
  consumedApplicationsThisPeriod: 0,
  atsResumeVariants: 0,
  connectedMailboxes: 0,
};

interface UsageRow {
  active_target_roles: number;
  verified_applications_this_period: number;
  consumed_applications_this_period: number;
  ats_resume_variants: number;
  connected_mailboxes: number;
}

/**
 * One RPC call per candidate. Acceptable at the scale this serves today (a
 * single-seat local engine) and flagged rather than hidden: at a few hundred
 * candidates this is a few hundred round trips, and the fix is a batch RPC that
 * groups by candidate_id - the same shape candidate_entitlement_usage already
 * has, aggregated. Not built now because nothing needs it yet and a speculative
 * batch function is another thing to keep in step with the single one.
 */
async function candidateUsage(client: SupabaseClient, candidateId: string): Promise<AdminBillingUsage> {
  const { data, error } = await client.rpc("candidate_entitlement_usage", { p_candidate_id: candidateId });

  if (error) {
    throw error;
  }

  const row = (Array.isArray(data) ? data[0] : data) as UsageRow | undefined;

  if (!row) {
    return ZERO_USAGE;
  }

  return {
    activeTargetRoles: row.active_target_roles,
    verifiedApplicationsThisPeriod: row.verified_applications_this_period,
    consumedApplicationsThisPeriod: row.consumed_applications_this_period,
    atsResumeVariants: row.ats_resume_variants,
    connectedMailboxes: row.connected_mailboxes,
  };
}

/**
 * Normalises a stored price to a monthly figure in minor units.
 *
 * THE WEEK CASE IS NOT OPTIONAL. Without it the else branch returns a WEEKLY
 * amount as if it were monthly, overstating that plan's MRR by ~4.35x — silently,
 * in the number an operator would use to make decisions. 52/12 rather than 4: a
 * year is not twelve four-week months.
 */
function monthlyMinor(amountMinor: number, interval: BillingInterval): number {
  if (interval === "year") {
    return Math.round(amountMinor / 12);
  }

  if (interval === "week") {
    return Math.round((amountMinor * 52) / 12);
  }

  return amountMinor;
}

export async function getAdminBilling(client: SupabaseClient): Promise<AdminBilling> {
  const plans = await listPlans(client);

  const planByCode = new Map(plans.map((plan) => [plan.code, plan]));
  const planById = new Map<string, (typeof plans)[number]>();

  const prices: AdminPriceRow[] = [];
  for (const plan of plans) {
    for (const price of plan.prices) {
      prices.push({
        planCode: plan.code,
        planDisplayName: plan.displayName,
        region: price.region,
        currency: price.currency,
        billingInterval: price.billingInterval,
        amountMinor: price.amountMinor,
        isActive: price.isActive,
      });
    }
  }

  const configuredLimitValues = plans.reduce((total, plan) => {
    if (!plan.limits) {
      return total;
    }
    return total + LIMIT_KEYS.filter((key) => plan.limits?.[key] !== null && plan.limits?.[key] !== undefined).length;
  }, 0);

  const [candidatesResult, subscriptionsResult] = await Promise.all([
    client
      .from("candidate_profiles")
      .select("id, created_at")
      .order("created_at", { ascending: false })
      .limit(ADMIN_BILLING_CANDIDATE_LIMIT),
    client
      .from("subscriptions")
      .select("candidate_id, plan_id, status, region, currency, billing_interval, current_period_end, cancel_at_period_end")
      .in("status", ["incomplete", "trialing", "active", "past_due", "unpaid"]),
  ]);

  if (candidatesResult.error) {
    throw candidatesResult.error;
  }
  if (subscriptionsResult.error) {
    throw subscriptionsResult.error;
  }

  const candidateRows = (candidatesResult.data ?? []) as Array<{ id: string }>;
  const subscriptionRows = (subscriptionsResult.data ?? []) as Array<{
    candidate_id: string;
    plan_id: string;
    status: string;
    region: string;
    currency: string;
    billing_interval: BillingInterval;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  }>;

  for (const plan of plans) {
    planById.set(plan.code, plan);
  }

  // Plan ids are not codes; resolve them once so the loop below is a lookup.
  const planIdToCode = new Map<string, string>();
  {
    const { data, error } = await client.from("subscription_plans").select("id, code");
    if (error) {
      throw error;
    }
    for (const row of (data ?? []) as Array<{ id: string; code: string }>) {
      planIdToCode.set(row.id, row.code);
    }
  }

  const subscriptionByCandidate = new Map<string, (typeof subscriptionRows)[number]>();
  for (const row of subscriptionRows) {
    subscriptionByCandidate.set(row.candidate_id, row);
  }

  // Emails come from the auth schema, which no table in public exposes. One
  // page is enough for this console today; a failure here degrades to null
  // emails rather than failing the whole section, because a billing view that
  // will not render without an email is worse than one showing a uuid.
  const emailById = new Map<string, string>();
  try {
    const { data } = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const user of data?.users ?? []) {
      if (user.email) {
        emailById.set(user.id, user.email);
      }
    }
  } catch {
    // Intentionally swallowed: see above.
  }

  const candidates: AdminBillingCandidate[] = [];

  for (const row of candidateRows) {
    const subscription = subscriptionByCandidate.get(row.id) ?? null;
    const planCode = subscription ? planIdToCode.get(subscription.plan_id) ?? null : null;
    const plan = planCode ? planByCode.get(planCode) ?? null : null;

    let mrrMinor = 0;
    if (subscription && plan && planCode) {
      const price = plan.prices.find(
        (entry) => entry.region === subscription.region && entry.billingInterval === subscription.billing_interval,
      );
      if (price && price.amountMinor !== null && price.isActive && subscription.status === "active") {
        mrrMinor = monthlyMinor(price.amountMinor, price.billingInterval);
      }
    }

    candidates.push({
      candidateId: row.id,
      email: emailById.get(row.id) ?? null,
      planCode,
      planDisplayName: plan?.displayName ?? null,
      status: subscription?.status ?? "none",
      region: subscription?.region ?? null,
      currency: subscription?.currency ?? null,
      billingInterval: subscription?.billing_interval ?? null,
      currentPeriodEnd: subscription?.current_period_end ?? null,
      cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
      monthlyRecurringRevenueMinor: mrrMinor,
      usage: await candidateUsage(client, row.id),
    });
  }

  const totalsByCurrency = new Map<string, AdminCurrencyTotal>();
  for (const candidate of candidates) {
    if (!candidate.currency || candidate.monthlyRecurringRevenueMinor === 0) {
      continue;
    }
    const existing = totalsByCurrency.get(candidate.currency) ?? {
      currency: candidate.currency,
      monthlyRecurringRevenueMinor: 0,
      payingCandidates: 0,
    };
    existing.monthlyRecurringRevenueMinor += candidate.monthlyRecurringRevenueMinor;
    existing.payingCandidates += 1;
    totalsByCurrency.set(candidate.currency, existing);
  }

  const planCounts: AdminPlanCount[] = plans.map((plan) => ({
    planCode: plan.code,
    planDisplayName: plan.displayName,
    subscribers: candidates.filter((candidate) => candidate.planCode === plan.code && candidate.status !== "none").length,
  }));

  return {
    candidates,
    currencyTotals: [...totalsByCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    planCounts,
    prices,
    configuredLimitValues,
    totalLimitValues: plans.length * LIMIT_KEYS.length,
    truncated: candidateRows.length >= ADMIN_BILLING_CANDIDATE_LIMIT,
  };
}
