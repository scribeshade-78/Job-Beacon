/**
 * Task H1 — billing client.
 *
 * Same "server-side Express route, not a direct Supabase call" shape as
 * lib/admin.ts. The billing tables have no candidate write path at all (there is
 * no INSERT/UPDATE grant to authenticated), so nothing here could write one even
 * if it tried — every mutation goes through a route that decides for itself.
 */

export type BillingInterval = "month" | "year";
export type BillingRegion = "IN" | "US" | "EU";

/** Mirrors server/billing/plans.ts PlanLimits. Every field nullable; NULL is "not configured". */
export interface PlanLimits {
  maxActiveTargetRoles: number | null;
  maxVerifiedApplicationsPerMonth: number | null;
  premiumSourceAccess: boolean | null;
  maxAtsResumeVariants: number | null;
  maxMailboxConnections: number | null;
  companyIntelligenceDepth: "none" | "basic" | "full" | null;
  priorityActionRequiredSupport: boolean | null;
  analyticsHistoryDays: number | null;
  dataExportsEnabled: boolean | null;
}

export interface RegionalPrice {
  region: string;
  currency: string;
  billingInterval: BillingInterval;
  amountMinor: number | null;
  isActive: boolean;
}

export interface BillingPlan {
  code: string;
  displayName: string;
  description: string | null;
  tierRank: number;
  limits: PlanLimits | null;
  prices: RegionalPrice[];
}

export interface EntitlementEvaluation {
  dimension: string;
  prdLabel: string;
  kind: "count" | "capability" | "depth";
  configured: boolean;
  allowed: boolean;
  limit: number | boolean | string | null;
  usage: number | null;
  remaining: number | null;
}

export interface EntitlementSummary {
  hasLiveSubscription: boolean;
  planCode: string | null;
  planDisplayName: string | null;
  evaluations: EntitlementEvaluation[];
  allUnconfigured: boolean;
}

export interface AdminBillingUsage {
  activeTargetRoles: number;
  verifiedApplicationsThisMonth: number;
  atsResumeVariants: number;
  connectedMailboxes: number;
}

export interface AdminBillingCandidate {
  candidateId: string;
  email: string | null;
  planCode: string | null;
  planDisplayName: string | null;
  status: string;
  region: string | null;
  currency: string | null;
  billingInterval: BillingInterval | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  monthlyRecurringRevenueMinor: number;
  usage: AdminBillingUsage;
}

export interface AdminBilling {
  candidates: AdminBillingCandidate[];
  currencyTotals: Array<{ currency: string; monthlyRecurringRevenueMinor: number; payingCandidates: number }>;
  planCounts: Array<{ planCode: string; planDisplayName: string; subscribers: number }>;
  prices: Array<{
    planCode: string;
    planDisplayName: string;
    region: string;
    currency: string;
    billingInterval: BillingInterval;
    amountMinor: number | null;
    isActive: boolean;
  }>;
  configuredLimitValues: number;
  totalLimitValues: number;
  truncated: boolean;
}

export type BillingFetchResult<T> =
  | { kind: "success"; data: T }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

const GENERIC_FAILURE = "Something went wrong. Please try again.";

/**
 * Minor units to a display string. Uses Intl so the grouping and the symbol come
 * from the currency itself rather than from a hand-rolled table, and divides by
 * 100 because every currency this product prices in is a two-decimal one
 * (INR paise, USD cents, EUR cents). A zero-decimal currency would need the
 * exponent looked up, and is called out rather than silently mishandled.
 */
export function formatMinorUnits(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

async function request<T>(
  path: string,
  accessToken: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<BillingFetchResult<T>> {
  let response: Response;

  try {
    response = await fetchImpl(path, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: "Bearer " + accessToken },
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "forbidden" };
  }

  if (!response.ok) {
    // The billing routes carry genuinely useful reasons (not priced yet, not
    // configured, already subscribed), so the server's own message is preferred
    // over a generic one where it exists.
    let message = GENERIC_FAILURE;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // keep the generic message
    }
    return { kind: "error", message };
  }

  return { kind: "success", data: (await response.json()) as T };
}

export function getBillingPlans(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return request<{ plans: BillingPlan[] }>("/api/billing/plans", accessToken, { method: "GET" }, fetchImpl);
}

export function getBillingSubscription(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return request<{ subscription: unknown; entitlements: EntitlementSummary }>(
    "/api/billing/subscription",
    accessToken,
    { method: "GET" },
    fetchImpl,
  );
}

export function startCheckout(
  input: { planCode: string; region: BillingRegion; billingInterval: BillingInterval },
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  return request<{ sessionId: string; url: string }>("/api/billing/checkout-session", accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, fetchImpl);
}

export function cancelSubscription(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return request<{ note: string }>("/api/billing/cancel", accessToken, { method: "POST" }, fetchImpl);
}

export function getAdminBilling(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return request<AdminBilling>("/api/admin/billing", accessToken, { method: "GET" }, fetchImpl);
}
