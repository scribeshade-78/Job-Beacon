import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import {
  getBillingSubscription,
  type BillingRegion,
  type EntitlementSummary,
} from "../lib/billing";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import {
  BILLING_REGIONS,
  DEFAULT_PLAN_CODE,
  FEATURE_MATRIX,
  PLAN_CATALOGUE,
  REGION_CURRENCY,
  REGION_OPTION_LABEL,
  checkoutLockNotice,
  planByCode,
  planDisplayName,
  type PlanCode,
} from "../../../shared/pricing";

/**
 * Candidate-facing Plans & Billing.
 *
 * EVERY VALUE ON THIS PAGE COMES FROM shared/pricing.ts, which is the single
 * source of truth for the catalogue, and NOT from the API. That is deliberate:
 * a pricing page that renders "not priced yet" because a regional row is missing
 * is a pricing page nobody can sell from, and the catalogue cannot be missing a
 * row — every plan has a price in every region by construction, with 0 being a
 * real price for Free rather than an absence.
 *
 * THE SERVER IS STILL ASKED ONE THING: /api/billing/subscription, so the page can
 * name the candidate's actual plan. It is asked only for that. Nothing here calls
 * the checkout route, because checkout is locked (see the notice) and a disabled
 * button that secretly fires a Stripe redirect would be worse than no button.
 *
 * PER-DESTINATION USAGE IS NOT SHOWN, because it is not measured yet: the
 * entitlement RPC counts applications globally. The quotas are therefore rendered
 * as allowances, which is what the catalogue actually states, rather than as
 * "12 of 30 used" — a number the database cannot currently produce.
 */

async function getAccessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Prices are whole units by design, so the shared minor-units formatter's forced
 * two decimals ("₹499.00") is noise in a price table. maximumFractionDigits stays
 * at 2 so a future non-whole price still renders correctly.
 */
function formatPrice(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function planCodeOf(entitlements: EntitlementSummary | null): PlanCode | null {
  const code = entitlements?.planCode;
  return code && PLAN_CATALOGUE.some((plan) => plan.code === code) ? (code as PlanCode) : null;
}

export function BillingPanel() {
  const [region, setRegion] = useState<BillingRegion>("IN");
  const [entitlements, setEntitlements] = useState<EntitlementSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const accessToken = await getAccessToken();

      if (!accessToken) {
        if (!cancelled) {
          setError("Your session has expired.");
          setLoading(false);
        }
        return;
      }

      const result = await getBillingSubscription(accessToken);
      if (cancelled) return;

      if (result.kind === "success") {
        setEntitlements(result.data.entitlements);

        // Open on the region this candidate is actually billed in, when they have
        // a subscription. Default stays IN, matching the catalogue's own ordering.
        const subscription = result.data.subscription as { region?: unknown } | null;
        const billed = subscription?.region;
        if (typeof billed === "string" && (BILLING_REGIONS as readonly string[]).includes(billed)) {
          setRegion(billed as BillingRegion);
        }
      } else if (result.kind === "forbidden") {
        setError("Your session has expired.");
      } else {
        setError(result.message);
      }

      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const currentCode = planCodeOf(entitlements);
  const currentPlan = planByCode(currentCode ?? DEFAULT_PLAN_CODE);
  const currentName = entitlements?.planDisplayName ?? planDisplayName(DEFAULT_PLAN_CODE);
  const currency = REGION_CURRENCY[region];
  const lockNotice = checkoutLockNotice(currentName);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Plans &amp; billing</CardTitle>
          <CardDescription>
            Four plans, priced per region. Every price below is the catalogue figure, and the
            region switcher changes both the currency and the amount.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Verbatim: headline, the plan the candidate is on, then the provider policy. */}
          <p
            role="status"
            className="flex items-start gap-2 rounded-control border border-ios-separator bg-ios-bg p-3 text-sm text-black"
          >
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{lockNotice}</span>
          </p>

          {error && (
            <p role="alert" className="text-sm text-status-blocked-fg">
              {error}
            </p>
          )}
          {loading && !error && <p className="text-sm text-ios-text-secondary">Loading…</p>}

          <div>
            <p className="text-sm font-medium text-black">Your plan</p>
            <p className="text-sm text-ios-text-secondary">
              {currentName} — {currentPlan.autoApplyPerMonth.india} auto-applies a month for India
              jobs and {currentPlan.autoApplyPerMonth.us} for US jobs.
              {entitlements && !entitlements.hasLiveSubscription
                ? " No paid subscription on file, so the Free allowance applies."
                : ""}
            </p>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-black">Region</p>
            <div role="group" aria-label="Billing region" className="flex flex-wrap gap-2">
              {BILLING_REGIONS.map((candidate) => (
                <Button
                  key={candidate}
                  size="sm"
                  variant={candidate === region ? "primary" : "secondary"}
                  aria-pressed={candidate === region}
                  onClick={() => setRegion(candidate)}
                >
                  {REGION_OPTION_LABEL[candidate]}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Monthly price</CardTitle>
          <CardDescription>
            Per month, in {currency}, for {REGION_OPTION_LABEL[region]}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[460px] border-collapse text-left">
              <thead>
                <tr className="border-b border-ios-separator text-xs uppercase tracking-wide text-ios-text-secondary">
                  <th className="py-2 pr-4 font-medium">Plan</th>
                  <th className="py-2 pr-4 font-medium">Price / month</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium" aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {PLAN_CATALOGUE.map((plan) => {
                  const isCurrent = plan.code === currentPlan.code;
                  return (
                    <tr key={plan.code} className="border-b border-ios-separator">
                      <td className="py-2 pr-4 text-sm text-black">
                        {plan.displayName}
                        <span className="block text-xs text-ios-text-secondary">{plan.description}</span>
                      </td>
                      <td className="py-2 pr-4 font-mono text-sm text-black">
                        {formatPrice(plan.monthlyPriceMinor[region], currency)}
                      </td>
                      <td className="py-2 pr-4 text-xs text-ios-text-secondary">
                        {isCurrent ? "Your plan" : "—"}
                      </td>
                      <td className="py-2 pr-4">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled
                          title="Checkout is locked — see the notice above."
                          aria-label={
                            isCurrent ? plan.displayName + " is your current plan" : "Checkout locked"
                          }
                        >
                          {isCurrent ? "Current plan" : plan.code === "free" ? "Free tier" : "Upgrade"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auto-apply per month</CardTitle>
          <CardDescription>
            By where the job is, not where you are. An unused India allowance does not become US
            allowance.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-left">
              <thead>
                <tr className="border-b border-ios-separator text-xs uppercase tracking-wide text-ios-text-secondary">
                  <th className="py-2 pr-4 font-medium">Plan</th>
                  <th className="py-2 pr-4 font-medium">India jobs</th>
                  <th className="py-2 pr-4 font-medium">US jobs</th>
                </tr>
              </thead>
              <tbody>
                {PLAN_CATALOGUE.map((plan) => (
                  <tr key={plan.code} className="border-b border-ios-separator">
                    <td className="py-2 pr-4 text-sm text-black">{plan.displayName}</td>
                    <td className="py-2 pr-4 font-mono text-sm text-black">
                      {plan.autoApplyPerMonth.india}
                    </td>
                    <td className="py-2 pr-4 font-mono text-sm text-black">
                      {plan.autoApplyPerMonth.us}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Features</CardTitle>
          <CardDescription>
            Rendered from the catalogue, so the table and the plans cannot disagree.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="border-b border-ios-separator text-xs uppercase tracking-wide text-ios-text-secondary">
                  <th className="py-2 pr-4 font-medium">Feature</th>
                  {PLAN_CATALOGUE.map((plan) => (
                    <th key={plan.code} className="py-2 pr-4 font-medium">
                      {plan.displayName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {FEATURE_MATRIX.map((row) => (
                  <tr key={row.feature} className="border-b border-ios-separator">
                    <td className="py-2 pr-4 text-sm text-black">{row.feature}</td>
                    {PLAN_CATALOGUE.map((plan) => (
                      <td key={plan.code} className="py-2 pr-4 text-sm text-ios-text-secondary">
                        {row.values[plan.code]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
