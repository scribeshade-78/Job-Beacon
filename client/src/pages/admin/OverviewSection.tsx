import { useEffect, useState } from "react";
import { getAdminOverview, type AdminOverview } from "../../lib/admin";
import { AdminCard, RefreshButton, SectionMessage, getAccessToken } from "./shared";

/**
 * R8.1 Overview. Three real counts, and a manual refresh because every one of
 * them moves without this page doing anything — a scheduler tick, a worker
 * drain, a moderation decision recorded elsewhere.
 */
export function OverviewSection() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumping the token re-runs the effect, so Refresh re-reads through the same
  // cancelled path as the initial load.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setBusy(true);

      const accessToken = await getAccessToken();
      if (!accessToken) {
        if (!cancelled) {
          setError("Your session has expired.");
          setBusy(false);
        }
        return;
      }

      const result = await getAdminOverview(accessToken);
      if (cancelled) return;

      if (result.kind === "success") {
        setOverview(result.data);
        setError(null);
      } else if (result.kind === "forbidden") {
        setError("You don't have admin access.");
      } else {
        setError(result.message);
      }

      setBusy(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const stats: Array<{ label: string; value: number | undefined }> = [
    { label: "Open moderation cases", value: overview?.openModerationCases },
    { label: "Active sources", value: overview?.activeSources },
    { label: "Total candidates", value: overview?.totalCandidates },
  ];

  return (
    <AdminCard
      title="System overview"
      description="Live counts from moderation_cases, source_policies, and candidate_profiles. MRR and error rate arrive with their own schema in a later phase."
      action={<RefreshButton onClick={() => setReloadToken((current) => current + 1)} busy={busy} />}
    >
      {error ? (
        <SectionMessage tone="error">{error}</SectionMessage>
      ) : (
        <dl className="grid gap-4 sm:grid-cols-3">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-md border border-slate-800 bg-slate-950/40 p-4">
              <dt className="text-xs text-slate-500">{stat.label}</dt>
              <dd className="mt-1 text-2xl font-semibold text-slate-100">
                {stat.value === undefined ? "…" : stat.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </AdminCard>
  );
}
