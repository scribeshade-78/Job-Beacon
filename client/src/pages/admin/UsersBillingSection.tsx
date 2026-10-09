import { useEffect, useState, type FormEvent } from "react";
import {
  formatMinorUnits,
  getAdminBilling,
  type AdminBilling,
  type AdminBillingCandidate,
} from "../../lib/billing";
import {
  getAdminRoles,
  grantAdminRole,
  revokeAdminRole,
  MANAGEABLE_ROLES,
  type AdminRoleAssignment,
  type AdminRoleList,
  type ManageableRole,
} from "../../lib/admin";
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

const FIELD_CLASS =
  "mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-600";

const BUTTON_CLASS =
  "rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-40";

/**
 * R8.2 role management: the admin/moderator assignment surface that replaces
 * hand-written SQL against public.user_roles after the initial bootstrap.
 *
 * THIS IS NOT THE AUTHORIZATION BOUNDARY. The three routes behind it are
 * requireAuth + requireAdmin, and user_roles is service_role-only at the
 * database grant level, so hiding a control here would change nothing about
 * who can grant a role. The disabled Revoke button on the signed-in admin's own
 * admin row mirrors the server's self-lockout refusal: belt and braces, not the
 * enforcement.
 */
function RolesCard() {
  const [roles, setRoles] = useState<AdminRoleList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ManageableRole>("moderator");

  async function load() {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      return;
    }

    const result = await getAdminRoles(accessToken);
    if (result.kind === "success") {
      setRoles(result.data);
      setError(null);
    } else if (result.kind === "forbidden") {
      setError("You don't have admin access.");
    } else {
      setError(result.message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setBusy(false);
      return;
    }

    const result = await grantAdminRole(email.trim(), role, accessToken);
    if (result.kind === "success") {
      // alreadyHeld is stated rather than inferred: a second grant is a no-op,
      // and telling the admin that is more useful than a second success notice.
      setNotice(
        result.data.alreadyHeld
          ? result.data.email + " already has the " + role + " role."
          : "Granted the " + role + " role to " + result.data.email + ".",
      );
      setEmail("");
      await load();
    } else if (result.kind === "forbidden") {
      setError("You don't have admin access.");
    } else {
      setError(result.message);
    }

    setBusy(false);
  }

  async function revoke(assignment: AdminRoleAssignment) {
    setBusy(true);
    setError(null);
    setNotice(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setBusy(false);
      return;
    }

    const result = await revokeAdminRole(assignment.userId, assignment.role, accessToken);
    if (result.kind === "success") {
      const who = assignment.email ?? assignment.userId;
      setNotice(
        result.data.removed
          ? "Revoked the " + assignment.role + " role from " + who + "."
          : who + " did not have the " + assignment.role + " role.",
      );
      await load();
    } else if (result.kind === "forbidden") {
      setError("You don't have admin access.");
    } else {
      setError(result.message);
    }

    setBusy(false);
  }

  return (
    <AdminCard
      title="Admins & moderators"
      description="Grant or revoke the admin and moderator roles. Every change is audited, and only the server can write public.user_roles."
    >
      {error && <SectionMessage tone="error">{error}</SectionMessage>}
      {notice && <p className="text-sm text-emerald-300">{notice}</p>}

      <form onSubmit={grant} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="min-w-[220px] flex-1 text-xs text-slate-400">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="person@example.com"
            className={FIELD_CLASS}
          />
        </label>
        <label className="text-xs text-slate-400">
          Role
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as ManageableRole)}
            className={FIELD_CLASS}
          >
            {MANAGEABLE_ROLES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy} className={BUTTON_CLASS}>
          Grant role
        </button>
      </form>

      {roles === null ? (
        <p className="mt-4 text-sm text-slate-500">Loading…</p>
      ) : roles.assignments.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No admin or moderator roles have been granted yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-4 font-medium">User</th>
                <th className="py-2 pr-4 font-medium">Role</th>
                <th className="py-2 pr-4 font-medium">Granted</th>
                <th className="py-2 pr-4 font-medium" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {roles.assignments.map((assignment) => {
                const selfAdmin = assignment.isSelf && assignment.role === "admin";
                return (
                  <tr key={assignment.userId + assignment.role} className="border-b border-slate-900">
                    <td className="py-2 pr-4 text-xs text-slate-300">
                      {assignment.email ?? assignment.userId}
                      {assignment.isSelf && <span className="ml-2 text-slate-500">(you)</span>}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      <span className={assignment.role === "admin" ? "text-sky-300" : "text-emerald-300"}>
                        {assignment.role}
                      </span>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-400" title={assignment.createdAt}>
                      {assignment.createdAt.slice(0, 10)}
                    </td>
                    <td className="py-2 pr-4">
                      <button
                        type="button"
                        disabled={busy || selfAdmin}
                        onClick={() => void revoke(assignment)}
                        title={selfAdmin ? "You cannot revoke your own admin role." : undefined}
                        className={BUTTON_CLASS}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {roles?.truncated && (
        <p className="mt-3 text-xs text-amber-400">
          The email lookup reached the server page limit, so some rows show an account id instead of an address.
        </p>
      )}

      <p className="mt-3 text-xs text-slate-500">
        Revoking admin from your own account is refused by the server, so this console cannot be locked out by mistake.
      </p>
    </AdminCard>
  );
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

  // The roles card renders in every billing state: a role read does not depend
  // on the billing read, and hiding it behind a revenue failure would make the
  // one section that can fix a missing admin unavailable exactly when needed.
  if (error) {
    return (
      <div className="space-y-4">
        <AdminCard title="Users & billing">
          <SectionMessage tone="error">{error}</SectionMessage>
        </AdminCard>
        <RolesCard />
      </div>
    );
  }

  if (!billing) {
    return (
      <div className="space-y-4">
        <AdminCard title="Users & billing">
          <SectionMessage tone="muted">Loading…</SectionMessage>
        </AdminCard>
        <RolesCard />
      </div>
    );
  }

  const paying = billing.candidates.filter((candidate) => candidate.monthlyRecurringRevenueMinor > 0).length;
  const limitsConfigured = billing.configuredLimitValues > 0;

  return (
    <div className="space-y-4">
      <RolesCard />

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
                    {price.billingInterval === "month"
                      ? "Monthly"
                      : price.billingInterval === "week"
                        ? "Weekly"
                        : "Annual"}
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
