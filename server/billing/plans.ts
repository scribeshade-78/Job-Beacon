import type { SupabaseClient } from "@supabase/supabase-js";
import { BILLING_REGIONS as PRICING_REGIONS, type BillingRegion } from "../../shared/pricing.js";

/**
 * Task H1 — reading the plan catalogue.
 *
 * Three queries joined in TypeScript rather than one PostgREST embedded select.
 * The embedded form types a to-one relation as an array, which then needs a
 * cast that hides exactly the kind of missing-row bug this module has to get
 * right (a plan with no limits row and a plan whose limits are all NULL must
 * stay distinguishable), so the explicit join is both clearer and safer.
 */

export type CompanyIntelligenceDepth = "none" | "basic" | "full";
export type BillingInterval = "week" | "month" | "year";

/**
 * Region comes from shared/pricing.ts rather than being listed again here. A
 * second list is exactly how "IN, US, EU" survived in the validation message
 * while another file gained UK.
 */
export type { BillingRegion };
export const BILLING_REGIONS: readonly BillingRegion[] = PRICING_REGIONS;
export const BILLING_INTERVALS: readonly BillingInterval[] = ["week", "month", "year"];

/**
 * The PRD v3 §27.2 dimensions, exactly as the table stores them.
 *
 * Every field is nullable and NULL means NOT CONFIGURED. It never means zero
 * and it never means unlimited — §27.3 explicitly forbids the word "unlimited"
 * for an application allowance that plans, source policy and eligibility also
 * constrain, so the UI has a third state to render and this type is what forces
 * it to be handled.
 */
export interface PlanLimits {
  maxActiveTargetRoles: number | null;
  maxVerifiedApplicationsPerMonth: number | null;
  premiumSourceAccess: boolean | null;
  maxAtsResumeVariants: number | null;
  maxMailboxConnections: number | null;
  companyIntelligenceDepth: CompanyIntelligenceDepth | null;
  priorityActionRequiredSupport: boolean | null;
  analyticsHistoryDays: number | null;
  dataExportsEnabled: boolean | null;
  /** Auto-apply allowance per month for jobs whose destination is India. */
  maxAutoApplyIndiaPerMonth: number | null;
  /** Auto-apply allowance per month for jobs whose destination is the US. */
  maxAutoApplyUsPerMonth: number | null;
}

export interface RegionalPrice {
  region: string;
  currency: string;
  billingInterval: BillingInterval;
  /** Minor units. NULL means this region/interval has not been priced yet. */
  amountMinor: number | null;
  isActive: boolean;
}

export interface BillingPlan {
  code: string;
  displayName: string;
  description: string | null;
  tierRank: number;
  isActive: boolean;
  /** Null when the plan has no plan_limits row at all — distinct from a row that is entirely unconfigured. */
  limits: PlanLimits | null;
  prices: RegionalPrice[];
}

const EMPTY_LIMITS: PlanLimits = {
  maxActiveTargetRoles: null,
  maxVerifiedApplicationsPerMonth: null,
  premiumSourceAccess: null,
  maxAtsResumeVariants: null,
  maxMailboxConnections: null,
  companyIntelligenceDepth: null,
  priorityActionRequiredSupport: null,
  analyticsHistoryDays: null,
  dataExportsEnabled: null,
  maxAutoApplyIndiaPerMonth: null,
  maxAutoApplyUsPerMonth: null,
};

interface PlanRow {
  id: string;
  code: string;
  display_name: string;
  description: string | null;
  tier_rank: number;
  is_active: boolean;
}

interface LimitRow {
  plan_id: string;
  max_active_target_roles: number | null;
  max_verified_applications_per_month: number | null;
  premium_source_access: boolean | null;
  max_ats_resume_variants: number | null;
  max_mailbox_connections: number | null;
  company_intelligence_depth: CompanyIntelligenceDepth | null;
  priority_action_required_support: boolean | null;
  analytics_history_days: number | null;
  data_exports_enabled: boolean | null;
  max_auto_apply_india_per_month: number | null;
  max_auto_apply_us_per_month: number | null;
}

interface PriceRow {
  plan_id: string;
  region: string;
  currency: string;
  billing_interval: BillingInterval;
  amount_minor: number | null;
  is_active: boolean;
}

/** The plan catalogue with its limits and every regional price row, priced or not. */
export async function listPlans(client: SupabaseClient): Promise<BillingPlan[]> {
  const [plansResult, limitsResult, pricesResult] = await Promise.all([
    client.from("subscription_plans").select("id, code, display_name, description, tier_rank, is_active").order("tier_rank"),
    client.from("plan_limits").select("*"),
    client.from("regional_prices").select("plan_id, region, currency, billing_interval, amount_minor, is_active"),
  ]);

  if (plansResult.error) {
    throw plansResult.error;
  }
  if (limitsResult.error) {
    throw limitsResult.error;
  }
  if (pricesResult.error) {
    throw pricesResult.error;
  }

  const limitsByPlan = new Map<string, PlanLimits>();
  for (const row of (limitsResult.data ?? []) as LimitRow[]) {
    limitsByPlan.set(row.plan_id, {
      maxActiveTargetRoles: row.max_active_target_roles,
      maxVerifiedApplicationsPerMonth: row.max_verified_applications_per_month,
      premiumSourceAccess: row.premium_source_access,
      maxAtsResumeVariants: row.max_ats_resume_variants,
      maxMailboxConnections: row.max_mailbox_connections,
      companyIntelligenceDepth: row.company_intelligence_depth,
      priorityActionRequiredSupport: row.priority_action_required_support,
      analyticsHistoryDays: row.analytics_history_days,
      dataExportsEnabled: row.data_exports_enabled,
      maxAutoApplyIndiaPerMonth: row.max_auto_apply_india_per_month,
      maxAutoApplyUsPerMonth: row.max_auto_apply_us_per_month,
    });
  }

  const pricesByPlan = new Map<string, RegionalPrice[]>();
  for (const row of (pricesResult.data ?? []) as PriceRow[]) {
    const list = pricesByPlan.get(row.plan_id) ?? [];
    list.push({
      region: row.region,
      currency: row.currency,
      billingInterval: row.billing_interval,
      amountMinor: row.amount_minor,
      isActive: row.is_active,
    });
    pricesByPlan.set(row.plan_id, list);
  }

  return ((plansResult.data ?? []) as PlanRow[]).map((row) => ({
    code: row.code,
    displayName: row.display_name,
    description: row.description,
    tierRank: row.tier_rank,
    isActive: row.is_active,
    limits: limitsByPlan.get(row.id) ?? null,
    prices: pricesByPlan.get(row.id) ?? [],
  }));
}

/** The single price row for a plan in a region and interval, or null when that combination is not priced/active. */
export function findActivePrice(
  plan: BillingPlan,
  region: string,
  interval: BillingInterval,
): RegionalPrice | null {
  const match = plan.prices.find((price) => price.region === region && price.billingInterval === interval);
  if (!match || !match.isActive || match.amountMinor === null) {
    return null;
  }
  return match;
}

export function isBillingRegion(value: unknown): value is BillingRegion {
  return typeof value === "string" && (BILLING_REGIONS as readonly string[]).includes(value);
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return typeof value === "string" && (BILLING_INTERVALS as readonly string[]).includes(value);
}

export { EMPTY_LIMITS };
