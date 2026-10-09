/**
 * JobBeacon pricing catalogue — THE single source of truth for plans, prices,
 * quotas and the feature matrix.
 *
 * WHY THIS EXISTS AS A CONSTANT AND NOT ONLY AS DATABASE ROWS. The database is
 * the runtime store (which candidate is on which plan, what they have consumed),
 * but the catalogue itself is a product decision that has to be readable in one
 * place, testable, and impossible to drift between the UI, the server and the
 * seed migration. The migration seeds these exact numbers and
 * shared/pricing.parity.test.ts parses that migration and fails if the two
 * disagree — so changing a price here without changing the seed (or the reverse)
 * is a test failure rather than a silent divergence between what a candidate is
 * shown and what the checkout route would charge.
 *
 * MONEY IS ALWAYS MINOR UNITS. Paise, cents, pence — integers, never floats. The
 * Free plan's 0 is a REAL price, not "unset": every region has a price for every
 * plan, so the pricing table never has a gap to explain.
 *
 * GBP IS A DELIBERATE DEPARTURE FROM THE PRD. PRD v3 §27.1 names INR, USD and
 * EUR. The UK/GBP column is a founder decision taken after that, recorded here
 * and in the migration rather than quietly added. The database CHECK constraints
 * were widened in the same change.
 */

export const PLAN_CODES = ["free", "starter", "pro", "power"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/** Free is the plan a candidate is on when they have no subscription row at all. */
export const DEFAULT_PLAN_CODE: PlanCode = "free";

export const BILLING_REGIONS = ["IN", "US", "UK", "EU"] as const;
export type BillingRegion = (typeof BILLING_REGIONS)[number];

/** Kept alongside region so a region/currency mismatch is impossible to express. */
export const REGION_CURRENCY: Record<BillingRegion, string> = {
  IN: "INR",
  US: "USD",
  UK: "GBP",
  EU: "EUR",
};

/** The switcher's option text, currency symbol included. */
export const REGION_OPTION_LABEL: Record<BillingRegion, string> = {
  IN: "India (₹)",
  US: "US ($)",
  UK: "UK (£)",
  EU: "EU (€)",
};

export interface PlanDefinition {
  code: PlanCode;
  displayName: string;
  description: string;
  /** Display order only. Lower sorts first; nothing computes on it. */
  tierRank: number;
  /** Monthly price in minor units for every region. */
  monthlyPriceMinor: Record<BillingRegion, number>;
  /**
   * Auto-apply allowance per month, split by where the JOB is — not where the
   * candidate is. This is the one quota the product states per destination.
   */
  autoApplyPerMonth: { india: number; us: number };
  /**
   * Mirrors plan_limits.max_verified_applications_per_month. Held here as well
   * because the pricing table shows it and the seed writes it.
   */
  verifiedApplicationsPerMonth: number;
  /**
   * Weekly price in minor units for every region. A flat record beside
   * monthlyPriceMinor rather than a nested Record<BillingInterval, ...>: 'year'
   * stays legal in the database but is deliberately unpriced, so a nested map
   * would force a null branch into every consumer for a case that cannot occur.
   */
  weeklyPriceMinor: Record<BillingRegion, number>;
  /**
   * Applications included per WEEK, for the weekly plans.
   *
   * DISPLAY ONLY — THERE IS NO COLUMN BEHIND THIS, ON PURPOSE. plan_limits stores
   * per-month figures and it was decided (2026-10-10) to keep it that way rather
   * than add per-week columns that nothing counts. A column here would be a number
   * no code reads, which is the trap the Free auto-apply allowance avoided. The
   * reset cadence and the interval factor arrive with the counters in phase 2c.
   */
  verifiedApplicationsPerWeek: number;
  /**
   * AUTOMATION allowance per week, per destination.
   *
   * Distinct from verifiedApplicationsPerWeek above, which is the TRACKED figure
   * shown on the pricing page and gates nothing. This pair is what the
   * plan_entitlement gate compares consumed attempts against, so the two must not
   * be collapsed into one "applications" number.
   */
  autoApplyPerWeek: { india: number; us: number };
  /** AI credits per billing period. One credit = one resume-tailoring or deep-cover-letter run. */
  aiCreditsPerMonth: number;
  aiCreditsPerWeek: number;
  /**
   * Distinct vacancies that may be first surfaced per CALENDAR DAY.
   *
   * NOT per billing period: discovery resets daily, so this is the one limit here
   * whose window is not the subscription's. Kept beside the others because it is
   * still an allowance, but it must never be compared against a period total.
   */
  dailyDiscoveryJobs: number;
  /** Mirrors plan_limits.max_mailbox_connections — 0 on Free is "Gmail connect: No". */
  maxMailboxConnections: number;
}

export const PLAN_CATALOGUE: readonly PlanDefinition[] = [
  {
    code: "free",
    displayName: "Free",
    description: "Everything needed to search, tailor and track, with no automation.",
    tierRank: 1,
    monthlyPriceMinor: { IN: 0, US: 0, UK: 0, EU: 0 },
    // THE AUTOMATION ALLOWANCE STAYS 0, DELIBERATELY. loadAutomationEntitlement
    // reads these two columns as a boolean ("is either destination above zero?"),
    // so any non-zero value here would grant Free unlimited automatic
    // applications rather than fifteen — see its own "THE QUOTA IS NOT YET A
    // COUNTER" note. Revisit only when the consumption counter exists.
    autoApplyPerMonth: { india: 0, us: 0 },
    // 15 is a DISPLAY allowance and nothing enforces it. Safe only because
    // max_verified_applications_per_month is read exclusively by the billing
    // matrix (server/billing/entitlements.ts, server/admin/billing.ts) and never
    // by an eligibility or authorization path — verified before setting it.
    verifiedApplicationsPerMonth: 15,
    verifiedApplicationsPerWeek: 5,
    weeklyPriceMinor: { IN: 0, US: 0, UK: 0, EU: 0 },
    autoApplyPerWeek: { india: 0, us: 0 },
    aiCreditsPerMonth: 2,
    aiCreditsPerWeek: 2,
    dailyDiscoveryJobs: 50,
    maxMailboxConnections: 0,
  },
  {
    code: "starter",
    displayName: "Starter",
    description: "Entry tier for a candidate running a focused search.",
    tierRank: 2,
    monthlyPriceMinor: { IN: 19900, US: 599, UK: 499, EU: 599 },
    autoApplyPerMonth: { india: 100, us: 100 },
    verifiedApplicationsPerMonth: 100,
    verifiedApplicationsPerWeek: 25,
    weeklyPriceMinor: { IN: 5900, US: 199, UK: 149, EU: 199 },
    autoApplyPerWeek: { india: 25, us: 25 },
    aiCreditsPerMonth: 100,
    aiCreditsPerWeek: 25,
    dailyDiscoveryJobs: 150,
    maxMailboxConnections: 1,
  },
  {
    code: "pro",
    displayName: "Premium International",
    // NOT "...and application". No plan can submit an application today: that
    // needs a source whose policy allows automated application AND an adapter
    // for it, and no source with vacancies has both. Advertising application as
    // a paid feature was untrue at every tier.
    description: "Full autonomous discovery for an active search.",
    tierRank: 3,
    monthlyPriceMinor: { IN: 99900, US: 2999, UK: 2499, EU: 2999 },
    autoApplyPerMonth: { india: 500, us: 500 },
    verifiedApplicationsPerMonth: 500,
    verifiedApplicationsPerWeek: 100,
    weeklyPriceMinor: { IN: 29900, US: 899, UK: 749, EU: 899 },
    autoApplyPerWeek: { india: 100, us: 100 },
    aiCreditsPerMonth: 500,
    aiCreditsPerWeek: 125,
    dailyDiscoveryJobs: 800,
    maxMailboxConnections: 1,
  },
  {
    code: "power",
    displayName: "Professional",
    description: "Highest allowance, for a candidate running a search at volume.",
    tierRank: 4,
    monthlyPriceMinor: { IN: 199900, US: 5999, UK: 4999, EU: 5999 },
    autoApplyPerMonth: { india: 1000, us: 1000 },
    verifiedApplicationsPerMonth: 1000,
    verifiedApplicationsPerWeek: 200,
    weeklyPriceMinor: { IN: 59900, US: 1799, UK: 1499, EU: 1799 },
    autoApplyPerWeek: { india: 200, us: 200 },
    aiCreditsPerMonth: 1000,
    aiCreditsPerWeek: 250,
    dailyDiscoveryJobs: 1500,
    maxMailboxConnections: 1,
  },
];

const BY_CODE = new Map<PlanCode, PlanDefinition>(PLAN_CATALOGUE.map((plan) => [plan.code, plan]));

export function planByCode(code: PlanCode): PlanDefinition {
  const plan = BY_CODE.get(code);
  if (!plan) {
    // Unreachable while PLAN_CODES and PLAN_CATALOGUE agree, which the parity
    // test enforces. Thrown rather than non-null asserted so the failure names
    // the missing code instead of producing "undefined.price".
    throw new Error("No plan catalogue entry for code: " + String(code));
  }
  return plan;
}

/** The display name for a plan code, tolerating an unknown code from the database. */
export function planDisplayName(code: string): string {
  return BY_CODE.get(code as PlanCode)?.displayName ?? code;
}

/**
 * Feature-matrix cells, rendered VERBATIM. These are marketing statements, not
 * enforcement gates: "Owner Control" is the existing user_roles concept. Nothing
 * here is read by an authorization decision, and the em dash for "not
 * applicable" is deliberate.
 *
 * THE AUTO-SUBMIT ROW WAS REMOVED, and must not be reinstated without a real
 * capability behind it. It was gated by an installed employer credential in
 * ats_credentials — not by a plan column — so no purchase could ever have
 * unlocked it, yet it was presented as a Pro/Power benefit. The monthly
 * auto-apply quotas are likewise no longer shown to candidates, though the
 * catalogue keeps the numbers because the seed and the parity test read them.
 */
export type FeatureCell = "Yes" | "No" | "Limited" | "Quota" | "Owner only" | "—";

export interface FeatureRow {
  feature: string;
  values: Record<PlanCode, FeatureCell>;
}

export const FEATURE_MATRIX: readonly FeatureRow[] = [
  {
    feature: "Resume + Profile + feed + paste/tailor + tracker",
    values: { free: "Yes", starter: "Yes", pro: "Yes", power: "Yes" },
  },
  {
    feature: "Inbox + Queue + company dossier",
    values: { free: "Yes", starter: "Yes", pro: "Yes", power: "Yes" },
  },
  {
    feature: "Reply drafts",
    values: { free: "Limited", starter: "Yes", pro: "Yes", power: "Yes" },
  },
  {
    feature: "Gmail connect",
    values: { free: "No", starter: "Yes", pro: "Yes", power: "Yes" },
  },
  {
    feature: "Owner Control",
    values: { free: "—", starter: "—", pro: "—", power: "Owner only" },
  },
];
