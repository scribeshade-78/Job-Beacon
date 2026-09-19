import { useEffect, useState } from "react";
import {
  formatMinorUnits,
  getAdminBilling,
  type AdminBilling,
  type AdminBillingCandidate,
} from "../../lib/billing";
import { AdminCard, SectionMessage, getAccessToken } from "./shared";

/**
 * Task H1 — "Users & Billing", wired to real tables.
 *
 * This replaces UsersBillingMock, which rendered three invented addresses and a
 * hardcoded MRR figure under a "Mock data" badge. There is no badge here and no
 * placeholder row: every value below is a count or a sum over rows in
 * subscriptions, regional_prices, subscription_plans and plan_limits, and the
 * component renders an explicit empty state when there is nothing to show.
 *
 * TWO THINGS IT DELIBERATELY WILL NOT DO.
 *
 * It will not blend currencies. Summing INR, USD and EUR needs an exchange rate
 * and this repository has no rate source, so a single headline MRR would be a
 * number nothing supports — on the screen a founder uses to judge revenue.
 * Revenue is reported per currency instead.
 *
 * It will not write "Unlimited" for an unconfigured plan limit. PRD v3 §27.3
 * forbids that wording, because an application allowance is always bounded by
 * source rate limits, trust blocks and eligibility whatever the plan says.
 * Unconfigured reads as "Not configured".
 */

const STATUS_LABELS: Record<string, string> = {
  none: "No plan",
  active: "Active",
  trialing: "Trialing",
  past_due: "Past due",
  unpaid: "Unpaid",
  incomplete: "Incomplete",
  canceled: "Cancelled",
};

function statusClass(status: string): string {
  if (status === "active" || status === "trialing") {
    return "text-emerald-300";
  }
  if (status === "past_due" || status === "unpaid") {
    return "text-amber-300";
  }
  if (status === "none" || status === "canceled") {
    return "text-slate-500";
  }
  return "text-slate-300";
}

function CandidateRow({ candidate }: { candidate: AdminBillingCandidate }) {
  const { usage } = candidate;

  return (
    <tr className="border-b border-slate-900 align-top">
      <td className="py-2 pr-4 text-xs text-slate-300">{candidate.email ?? candidate.candidateId}</td>
      <td className="py-2 pr-4 text-xs text-slate-400">{candidate.planDisplayName ?? "—"}</td>
      <td className={"py-2 pr-4 text-xs " + statusClass(candidate.status)}>
        {STATUS_LABELS[candidate.status] ?? candidate.status}
        {candidate.cancelAtPeriodEnd && <span className="ml-1 text-slate-500">(ends)</span>}
      </td>
      <td className="py-2 pr-4 text-xs text-slate-400">{candidate.region ?? "—"}</td>
      <td className="py-2 pr-4 font-mono text-xs text-slate-400">
        {candidate.currentPeriodEnd ? candidate.currentPeriodEnd.slice(0, 10) : "—"}
      </td>
      <td className="py-2 pr-4 font-mono text-xs text-slate-400">
        {candidate.monthlyRecurringRevenueMinor > 0 && candidate.currency
          ? formatMinorUnits(candidate.monthlyRecurringRevenueMinor, candidate.currency)
          : "—"}
      </td>
      <td className="py-2 pr-4 text-xs text-slate-500">
        {usage.activeTargetRoles} roles · {usage.verifiedApplicationsThisMonth} apps ·{" "}
        {usage.atsResumeVariants} variants · {usage.connectedMailboxes} mailboxes
      </td>
    </tr>
  );
}

export function UsersBillingSection() {
  const [billing, setBilling] = useState<AdminBilling | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        if (!cancelled) {
          setError("Your session has expired.");
        }
        return;
      }

      const result = await getAdminBilling(accessToken);

      if (cancelled) {
        return;
      }

      if (result.kind === "success") {
        setBilling(result.data);
        setError(null);
      } else if (result.kind === "forbidden") {
        setError("You don't have admin access.");
      } else {
        setError(result.message);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <AdminCard title="Users & billing">
        <SectionMessage tone="error">{error}</SectionMessage>
      </AdminCard>
    );
  }

  if (!billing) {
    return (
      <AdminCard title="Users & billing">
        <SectionMessage tone="muted">Loading…</SectionMessage>
      </AdminCard>
    );
  }

  const paying = billing.candidates.filter((candidate) => candidate.monthlyRecurringRevenueMinor > 0).length;
  const limitsConfigured = billing.configuredLimitValues > 0;

  return (
    <div className="space-y-4">
      <AdminCard
        title="Revenue"
        description="Computed from active subscriptions joined to the regional price they were sold at. Annual prices are normalised to a monthly figure."
      >
        {billing.currencyTotals.length === 0 ? (
          <SectionMessage tone="muted">No revenue yet — no candidate has an active paid plan.</SectionMessage>
        ) : (
          <dl className="space-y-2">
            {billing.currencyTotals.map((total) => (
              <div key={total.currency} className="flex justify-between rounded border border-slate-800 bg-slate-950/40 px-3 py-2">
                <dt className="text-slate-400">MRR ({total.currency})</dt>
                <dd className="font-mono text-slate-200">
                  {formatMinorUnits(total.monthlyRecurringRevenueMinor, total.currency)}
                  <span className="ml-2 text-xs text-slate-500">
                    across {total.payingCandidates} candidate{total.payingCandidates === 1 ? "" : "s"}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        )}

        <p className="mt-3 text-xs text-slate-500">
          Reported per currency on purpose. A single blended total would need an exchange rate, and no rate source
          exists in this deployment — so a combined figure here would be a number nothing supports.
        </p>
      </AdminCard>

      <AdminCard
        title="Plan limits"
        description="PRD v3 §27.2 defines eight plan-limit dimensions. Their values are a founder decision and none is set yet."
      >
        <div className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/40 px-3 py-2">
          <span className="text-slate-400">Dimension values configured</span>
          <span className="font-mono text-slate-200">
            {billing.configuredLimitValues} / {billing.totalLimitValues}
          </span>
        </div>

        <p className={limitsConfigured ? "mt-3 text-xs text-slate-500" : "mt-3 text-xs text-amber-400"}>
          {limitsConfigured
            ? "Some dimensions are configured. Everything unset reads as Not configured."
            : "No plan limits are configured, so no dimension is enforced. Unset is shown as Not configured rather than Unlimited — §27.3 forbids describing a plan allowance that way, because source policy, trust and eligibility bound it regardless."}
        </p>
      </AdminCard>

      <AdminCard title="Candidates" description="Subscription state and current usage against the §27.2 dimensions.">
        {billing.candidates.length === 0 ? (
          <SectionMessage tone="muted">No candidates yet.</SectionMessage>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4 font-medium">Candidate</th>
                  <th className="py-2 pr-4 font-medium">Plan</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Region</th>
                  <th className="py-2 pr-4 font-medium">Renews</th>
                  <th className="py-2 pr-4 font-medium">MRR</th>
                  <th className="py-2 pr-4 font-medium">Usage</th>
                </tr>
              </thead>
              <tbody>
                {billing.candidates.map((candidate) => (
                  <CandidateRow key={candidate.candidateId} candidate={candidate} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {billing.truncated && (
          <p className="mt-3 text-xs text-amber-400">
            List truncated at the server's candidate limit. Older candidates are not shown.
          </p>
        )}

        <p className="mt-3 text-xs text-slate-500">
          {paying === 0 ? "Nobody is paying yet." : paying + " paying candidate(s)."} Usage is shown whether or not a
          plan is active, so limits can be set from observed consumption.
        </p>
      </AdminCard>

      <AdminCard
        title="Regional prices"
        description="PRD v3 §27.1 supports INR, USD and EUR. A row with no amount is a region that has not been priced yet."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-4 font-medium">Plan</th>
                <th className="py-2 pr-4 font-medium">Region</th>
                <th className="py-2 pr-4 font-medium">Interval</th>
                <th className="py-2 pr-4 font-medium">Price</th>
                <th className="py-2 pr-4 font-medium">Sellable</th>
              </tr>
            </thead>
            <tbody>
              {billing.prices.map((price) => (
                <tr key={price.planCode + price.region + price.billingInterval} className="border-b border-slate-900">
                  <td className="py-2 pr-4 text-xs text-slate-300">{price.planDisplayName}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-400">
                    {price.region} · {price.currency}
                  </td>
                  <td className="py-2 pr-4 text-xs text-slate-400">
                    {price.billingInterval === "month" ? "Monthly" : "Annual"}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-300">
                    {price.amountMinor === null ? (
                      <span className="text-slate-500">Not priced</span>
                    ) : (
                      formatMinorUnits(price.amountMinor, price.currency)
                    )}
                  </td>
                  <td className="py-2 pr-4 text-xs">
                    {price.isActive ? <span className="text-emerald-300">Yes</span> : <span className="text-slate-500">No</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>
    </div>
  );
}
