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
    autoApplyPerMonth: { india: 0, us: 0 },
    verifiedApplicationsPerMonth: 0,
    maxMailboxConnections: 0,
  },
  {
    code: "starter",
    displayName: "Starter",
    description: "Entry tier for a candidate running a focused search.",
    tierRank: 2,
    monthlyPriceMinor: { IN: 49900, US: 1900, UK: 1200, EU: 1500 },
    autoApplyPerMonth: { india: 30, us: 80 },
    verifiedApplicationsPerMonth: 80,
    maxMailboxConnections: 1,
  },
  {
    code: "pro",
    displayName: "Pro",
    description: "Full autonomous discovery and application for an active search.",
    tierRank: 3,
    monthlyPriceMinor: { IN: 99900, US: 3900, UK: 2500, EU: 3200 },
    autoApplyPerMonth: { india: 100, us: 300 },
    verifiedApplicationsPerMonth: 300,
    maxMailboxConnections: 1,
  },
  {
    code: "power",
    displayName: "Power",
    description: "Highest allowance, for a candidate applying at volume.",
    tierRank: 4,
    monthlyPriceMinor: { IN: 249900, US: 9900, UK: 6900, EU: 8500 },
    autoApplyPerMonth: { india: 750, us: 1000 },
    verifiedApplicationsPerMonth: 1000,
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
 * enforcement gates: "Owner Control" is the existing user_roles concept and
 * "Auto-submit (Greenhouse)" is gated by an installed employer credential in
 * ats_credentials, not by a plan column. Nothing here is read by an
 * authorization decision, and the em dash for "not applicable" is deliberate.
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
    feature: "Auto-submit (Greenhouse)",
    values: { free: "No", starter: "Quota", pro: "Quota", power: "Quota" },
  },
  {
    feature: "Owner Control",
    values: { free: "—", starter: "—", pro: "—", power: "Owner only" },
  },
];
