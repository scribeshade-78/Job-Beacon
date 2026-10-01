import { useEffect, useState } from "react";
import { Check, ChevronDown, Minus, X } from "lucide-react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  createRazorpayOrder,
  getBillingSubscription,
  selectPlan,
  startCheckout,
  verifyRazorpayPayment,
  type BillingProviders,
  type EntitlementEvaluation,
  type EntitlementSummary,
} from "../lib/billing";
import {
  REGION_SWITCHER_LABEL,
  detectRegionFromBrowser,
} from "../lib/region";
import { openRazorpayCheckout } from "../lib/razorpayCheckout";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { cn } from "../lib/utils";
import {
  BILLING_REGIONS,
  DEFAULT_PLAN_CODE,
  FEATURE_MATRIX,
  PLAN_CATALOGUE,
  REGION_CURRENCY,
  planByCode,
  planDisplayName,
  type BillingRegion,
  type FeatureCell,
  type PlanCode,
  type PlanDefinition,
} from "../../../shared/pricing";

/**
 * Candidate-facing Plans & Pricing.
 *
 * EVERY NUMBER COMES FROM shared/pricing.ts, NOT FROM THE API. A pricing page
 * that renders "not priced yet" because a regional row is missing cannot be sold
 * from, and the catalogue has no such gap: every plan is priced in every region
 * by construction, with 0 being a REAL price for Free rather than an absence.
 * The server is asked only which plan the candidate is on.
 *
 * THE REGION PILL CHANGES WHAT IS DISPLAYED, NEVER WHAT IS STORED. Switching it
 * re-prices the cards and swaps which quota bullet is shown; it does not touch an
 * existing subscription row. A candidate who bought Pro in India stays on Pro in
 * India — re-pricing somebody because they switched a toggle would be a billing
 * bug, and the region a subscription was bought in is a fact about that
 * subscription, not a display preference.
 *
 * TWO WAYS TO UPGRADE, CHOSEN BY THE SERVER'S CONFIGURATION:
 *   1. The region's provider is configured — Razorpay for IN, Stripe for
 *      US/UK/EU — so the CTA starts a real Checkout and the plan activates when
 *      the payment is verified.
 *   2. It is not, which is this deployment's state today, so the CTA activates
 *      the plan directly under early access. The dialog says so in as many words:
 *      it activates immediately and no charge is taken. That is a deliberate
 *      pre-launch decision, and the copy is the honest part of it.
 *
 * The server decides which of the two applies by refusing select-plan with a 409
 * once credentials exist, so this fallback closes itself.
 */

/**
 * Prices are whole units by design, so forcing two decimals ("₹499.00") is noise
 * in a price card. maximumFractionDigits stays at 2 so a future non-whole price
 * still renders correctly.
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

/** Which provider, if any, can take money in this region. Mirrors the server's own routing. */
function providerForRegion(region: BillingRegion, providers: Partial<BillingProviders> | null): "razorpay" | "stripe" | null {
  // One provider per region: Razorpay is India-first, Stripe covers the rest.
  if (region === "IN") {
    return providers?.razorpayConfigured ? "razorpay" : null;
  }

  return providers?.stripeConfigured ? "stripe" : null;
}

/**
 * The card's selling points.
 *
 * NO AUTO-APPLY BULLET, AND NO "No automated applying" ON FREE EITHER.
 *
 * The monthly auto-apply figures were removed because no plan can consume them:
 * submitting an application needs a source whose policy allows automated
 * application AND an adapter registered for it, and no source holding vacancies
 * has both. Showing "30 auto-applies / month" sold a capability that did not
 * exist.
 *
 * Free's old bullet ("No automated applying") had the same defect from the other
 * direction: listing it only on Free implies the paid tiers DO have automated
 * applying. They do not. The truthful statement is the same at every tier, so it
 * is made once, in the panel notice below, rather than as a per-plan contrast.
 */
function highlightsFor(plan: PlanDefinition): string[] {
  const verified = plan.verifiedApplicationsPerMonth;

  switch (plan.code) {
    case "free":
      return [
        "Search, tailor and track applications",
        "Job feed and company dossiers",
        "Reply drafts (limited)",
      ];
    case "starter":
      return [
        verified + " verified applications / month",
        "Gmail connect and reply drafts",
        "Job feed and company dossiers",
      ];
    case "pro":
      return [
        verified + " verified applications / month",
        "Gmail connect and reply drafts",
        "Job feed and company dossiers",
      ];
    case "power":
      return [
        verified + " verified applications / month",
        "Gmail connect and reply drafts",
        "Owner Control",
      ];
  }
}

function findEvaluation(
  entitlements: EntitlementSummary | null,
  dimension: string,
): EntitlementEvaluation | undefined {
  return entitlements?.evaluations.find((entry) => entry.dimension === dimension);
}

/**
 * "12 of 80 used" only when the database can actually produce the number.
 *
 * A count dimension with usage null is not zero — it is unmeasured, and a
 * progress bar built on it would report a precise-looking lie. The allowance is
 * still shown; the consumed figure is omitted.
 */
function usageLine(entitlements: EntitlementSummary | null, dimension: string, label: string): string | null {
  const evaluation = findEvaluation(entitlements, dimension);

  if (!evaluation || typeof evaluation.limit !== "number" || evaluation.limit <= 0) {
    return null;
  }

  if (evaluation.usage === null || evaluation.remaining === null) {
    return label + ": up to " + evaluation.limit + " / month";
  }

  return label + ": " + evaluation.usage + " of " + evaluation.limit + " used";
}

function FeatureCellView({ cell }: { cell: FeatureCell }) {
  if (cell === "Yes") {
    return <Check className="h-4 w-4 text-status-verified-fg" aria-label="Included" />;
  }

  if (cell === "No") {
    return <X className="h-4 w-4 text-ios-text-secondary" aria-label="Not included" />;
  }

  if (cell === "—") {
    return <Minus className="h-4 w-4 text-ios-text-secondary" aria-label="Not applicable" />;
  }

  // "Limited", "Quota" and "Owner only" carry meaning a tick cannot, so they stay
  // words — but as a small label rather than a cell of prose.
  return <span className="text-xs font-medium text-ios-text-secondary">{cell}</span>;
}

const UPGRADE_CTA_CLASSES =
  "bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold cursor-pointer";

function PlanCard({
  plan,
  region,
  currency,
  currentCode,
  onSelect,
}: {
  plan: PlanDefinition;
  region: BillingRegion;
  currency: string;
  currentCode: PlanCode;
  onSelect: (plan: PlanDefinition) => void;
}) {
  const isCurrent = plan.code === currentCode;
  const isPopular = plan.code === "pro";

  return (
    <div
      className={cn(
        "flex flex-col rounded-card border bg-ios-card p-5 shadow-card",
        isPopular ? "border-ios-blue ring-1 ring-ios-blue" : "border-ios-separator",
      )}
    >
      {/* Fixed-height slot so plan names line up whether or not a card carries
          the badge. */}
      <div className="mb-3 flex h-6 items-center">
        {isPopular && (
          <span className="rounded-full bg-blue-600 px-2.5 py-0.5 text-xs font-semibold text-white">
            Most Popular
          </span>
        )}
      </div>

      <h3 className="text-lg font-semibold text-black">{plan.displayName}</h3>
      <p className="mt-1 min-h-[40px] text-sm text-ios-text-secondary">{plan.description}</p>

      <p className="mt-4 flex items-baseline gap-1.5">
        <span className="text-4xl font-bold tracking-tight text-black">
          {formatPrice(plan.monthlyPriceMinor[region], currency)}
        </span>
        <span className="text-sm text-ios-text-secondary">/ month</span>
      </p>

      <ul className="mt-5 flex-1 space-y-2.5">
        {highlightsFor(plan).map((highlight) => (
          <li key={highlight} className="flex gap-2 text-sm text-black">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-status-verified-fg" aria-hidden="true" />
            <span>{highlight}</span>
          </li>
        ))}
      </ul>

      {isCurrent ? (
        <Button className="mt-6 w-full" variant="secondary" disabled aria-label={plan.displayName + " is your current plan"}>
          Current plan
        </Button>
      ) : (
        <Button
          className={cn("mt-6 w-full", UPGRADE_CTA_CLASSES)}
          onClick={() => onSelect(plan)}
          aria-label={
            plan.code === "free" ? "Switch to the Free plan" : "Upgrade to " + plan.displayName
          }
        >
          {plan.code === "free" ? "Get started" : "Upgrade to " + plan.displayName}
        </Button>
      )}
    </div>
  );
}

export function BillingPanel() {
  // Auto-detected on mount, then owned by the candidate. The pill is a display
  // preference after that.
  const [region, setRegion] = useState<BillingRegion>(() => detectRegionFromBrowser());
  const [entitlements, setEntitlements] = useState<EntitlementSummary | null>(null);
  const [providers, setProviders] = useState<Partial<BillingProviders> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [pendingPlan, setPendingPlan] = useState<PlanDefinition | null>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function getAccessToken(): Promise<string | null> {
    const { data } = await getSupabaseBrowserClient().auth.getSession();
    return data.session?.access_token ?? null;
  }

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
        setProviders(result.data.providers ?? null);

        // Open on the region this candidate is actually billed in, when they have
        // a subscription. Detection only decides the default.
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

  const currentCode = planCodeOf(entitlements) ?? DEFAULT_PLAN_CODE;
  const currentName = entitlements?.planDisplayName ?? planDisplayName(DEFAULT_PLAN_CODE);
  const currency = REGION_CURRENCY[region];

  const activeProvider = providerForRegion(region, providers);
  const pendingProvider = pendingPlan ? providerForRegion(region, providers) : null;

  const verifiedLine = usageLine(entitlements, "verified_applications_per_month", "Verified applications");

  // NO AUTO-APPLY USAGE LINE. This status bar used to report the candidate's
  // monthly auto-apply allowance and how much of it was consumed, per region.
  // Nothing can consume it — see highlightsFor above — so it was a live,
  // per-account claim that the product would apply for jobs on their behalf.
  // verifiedLine stays: verified applications is a separate dimension.

  function closeDialog() {
    setPendingPlan(null);
    setActionError(null);
  }

  async function applyEntitlements(payload: { entitlements: EntitlementSummary }) {
    setEntitlements(payload.entitlements);
  }

  async function confirmSelection() {
    if (!pendingPlan) return;

    setWorking(true);
    setActionError(null);

    const accessToken = await getAccessToken();

    if (!accessToken) {
      setActionError("Your session has expired. Please sign in again.");
      setWorking(false);
      return;
    }

    const planCode = pendingPlan.code;

    try {
      // Free is a downgrade, not a purchase: it closes the live row.
      if (planCode === "free") {
        const result = await selectPlan({ planCode, region }, accessToken);

        if (result.kind !== "success") {
          setActionError(result.kind === "error" ? result.message : "Could not switch to Free.");
          return;
        }

        await applyEntitlements(result.data);
        closeDialog();
        return;
      }

      if (activeProvider === "razorpay") {
        const order = await createRazorpayOrder({ planCode, region }, accessToken);

        if (order.kind !== "success") {
          setActionError(order.kind === "error" ? order.message : "Could not start the payment.");
          return;
        }

        const outcome = await openRazorpayCheckout({
          keyId: order.data.keyId,
          orderId: order.data.orderId,
          amountMinor: order.data.amountMinor,
          currency: order.data.currency,
          planName: pendingPlan.displayName,
        });

        if (outcome.kind === "dismissed") {
          // Cancelling is not an error, so nothing is shown.
          return;
        }

        if (outcome.kind === "unavailable") {
          setActionError(outcome.message);
          return;
        }

        // The server verifies the signature AND reads the plan back out of the
        // order, so nothing about the purchase is taken from this browser.
        const verified = await verifyRazorpayPayment(
          {
            razorpay_order_id: outcome.orderId,
            razorpay_payment_id: outcome.paymentId,
            razorpay_signature: outcome.signature,
          },
          accessToken,
        );

        if (verified.kind !== "success") {
          setActionError(
            verified.kind === "error"
              ? verified.message
              : "The payment could not be verified. If you were charged, contact support.",
          );
          return;
        }

        await applyEntitlements(verified.data);
        closeDialog();
        return;
      }

      if (activeProvider === "stripe") {
        const result = await startCheckout({ planCode, region, billingInterval: "month" }, accessToken);

        if (result.kind !== "success") {
          setActionError(result.kind === "error" ? result.message : "Could not start checkout.");
          return;
        }

        // Stripe owns the payment page from here.
        window.location.href = result.data.url;
        return;
      }

      // No provider configured for this region: the early-access path.
      const result = await selectPlan({ planCode, region }, accessToken);

      if (result.kind !== "success") {
        setActionError(result.kind === "error" ? result.message : "Could not activate that plan.");
        return;
      }

      await applyEntitlements(result.data);
      closeDialog();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Compact status bar: the plan and its quotas, one line, no prose. */}
      <section
        aria-label="Your plan"
        className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-card border border-ios-separator bg-ios-card px-4 py-3 text-sm shadow-card"
      >
        <span className="flex items-center gap-2">
          <span className="text-ios-text-secondary">Your plan</span>
          <span className="rounded-full bg-ios-blue/10 px-2.5 py-0.5 text-xs font-semibold text-ios-blue">
            {loading ? "…" : currentName}
          </span>
          {entitlements && !entitlements.hasLiveSubscription && (
            <span className="text-xs text-ios-text-secondary">Free allowance</span>
          )}
        </span>

        {!entitlements && error && <span className="text-xs text-status-blocked-fg">{error}</span>}

        {entitlements && (
          <>
            {verifiedLine && <span className="text-ios-text-secondary">{verifiedLine}</span>}
          </>
        )}
      </section>

      {/* Heading and the region pill. */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-black">Plans &amp; pricing</h2>
            <p className="mt-1 text-sm text-ios-text-secondary">
              Simple monthly pricing. Change or cancel any time.
            </p>
          </div>

          <div
            role="group"
            aria-label="Billing region"
            className="inline-flex flex-wrap gap-1 rounded-full border border-ios-separator bg-ios-card p-1 shadow-card"
          >
            {BILLING_REGIONS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={candidate === region}
                onClick={() => setRegion(candidate)}
                className={cn(
                  "cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors",
                  candidate === region
                    ? "bg-blue-600 text-white"
                    : "text-ios-text-secondary hover:bg-ios-bg",
                )}
              >
                {REGION_SWITCHER_LABEL[candidate]}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* STATED ONCE, FOR EVERY TIER, RATHER THAN AS A PER-PLAN CONTRAST.
          Automated application is not available at any price yet — it needs a
          job source that both permits automated application and has an adapter
          for it, and no source with vacancies has both. Saying it here keeps the
          pricing cards describing what a candidate can actually do today, and
          removes the implication that a higher tier unlocks submission. */}
      <p
        role="note"
        className="rounded-control border border-ios-separator bg-ios-bg px-4 py-3 text-sm text-ios-text-secondary"
      >
        <span className="font-medium text-black">Automatic submission unavailable.</span>{" "}
        You can search, tailor and track applications on every plan, and open each job’s original
        posting to apply. We’ll state the allowance clearly here once automatic submission is live
        for a supported employer.
      </p>

      <section aria-label="Plans" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {PLAN_CATALOGUE.map((plan) => (
          <PlanCard
            key={plan.code}
            plan={plan}
            region={region}
            currency={currency}
            currentCode={currentCode}
            onSelect={(selected) => {
              setActionError(null);
              setPendingPlan(selected);
            }}
          />
        ))}
      </section>

      {/* The detail, folded away so it does not compete with the cards. */}
      <details className="group rounded-card border border-ios-separator bg-ios-card shadow-card">
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-semibold text-black">
          Compare all features
          <ChevronDown
            className="h-4 w-4 shrink-0 text-ios-text-secondary transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>

        <div className="overflow-x-auto border-t border-ios-separator px-5 py-4">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ios-text-secondary">
                <th scope="col" className="pb-3 pr-4 font-medium">
                  Feature
                </th>
                {PLAN_CATALOGUE.map((plan) => (
                  <th key={plan.code} scope="col" className="pb-3 pr-4 font-medium">
                    {plan.displayName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FEATURE_MATRIX.map((row) => (
                <tr key={row.feature} className="border-t border-ios-separator">
                  <th scope="row" className="py-3 pr-4 text-sm font-normal text-black">
                    {row.feature}
                  </th>
                  {PLAN_CATALOGUE.map((plan) => (
                    <td key={plan.code} className="py-3 pr-4">
                      <FeatureCellView cell={row.values[plan.code]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <Dialog
        open={pendingPlan !== null}
        onOpenChange={(next) => {
          if (!next) closeDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingPlan?.code === "free"
                ? "Switch to the Free plan?"
                : "Upgrade to " + (pendingPlan?.displayName ?? "") + "?"}
            </DialogTitle>
            <DialogDescription>
              {pendingPlan && pendingPlan.code !== "free" ? (
                <>
                  {pendingPlan.displayName} · {REGION_SWITCHER_LABEL[region]} ·{" "}
                  {formatPrice(pendingPlan.monthlyPriceMinor[region], currency)} / month
                </>
              ) : (
                "You will keep read access to everything you have created."
              )}
            </DialogDescription>
          </DialogHeader>

          {pendingPlan && pendingPlan.code !== "free" && (
            <p className="text-sm text-black">
              {pendingProvider === "razorpay" || pendingProvider === "stripe" ? (
                <>
                  You will be taken to {pendingProvider === "razorpay" ? "Razorpay" : "Stripe"} to pay{" "}
                  {formatPrice(pendingPlan.monthlyPriceMinor[region], currency)}. Your plan activates once
                  the payment is verified.
                </>
              ) : (
                <>
                  <strong>Early access:</strong> card payments are not configured for this region yet, so
                  this activates immediately and <strong>no charge is taken today</strong>. You can change
                  or cancel it at any time.
                </>
              )}
            </p>
          )}

          {actionError && (
            <p role="alert" className="mt-3 text-sm text-status-blocked-fg">
              {actionError}
            </p>
          )}

          <DialogFooter>
            <Button variant="secondary" onClick={closeDialog} disabled={working}>
              Cancel
            </Button>
            <Button
              className={UPGRADE_CTA_CLASSES}
              onClick={() => void confirmSelection()}
              disabled={working}
            >
              {working
                ? "Working…"
                : pendingPlan?.code === "free"
                  ? "Switch to Free"
                  : pendingProvider === "razorpay" || pendingProvider === "stripe"
                    ? "Continue to payment"
                    : "Activate now — no charge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
