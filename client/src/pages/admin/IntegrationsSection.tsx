import { useEffect, useState } from "react";
import {
  getAdminIntegrations,
  type AdminIntegrationStatus,
  type AdminIntegrationsOverview,
} from "../../lib/admin";
import { AdminCard, RefreshButton, SectionMessage, getAccessToken } from "./shared";

/**
 * Integrations — can the SERVER actually use each provider?
 *
 * PRESENCE ONLY, AND THAT IS A HARD BOUNDARY. The server reports booleans plus the
 * names of missing variables; no value ever reaches this page, and the client type has
 * no field that could carry one. An operator needs to know that a key is present (or
 * which one is absent) — never what it is.
 *
 * The governance columns are shown alongside presence on purpose: Adzuna can be fully
 * configured and still be correct to keep OFF the unattended schedule, and a console
 * that showed only "Active" would invite exactly the wrong conclusion.
 */
export function IntegrationsSection() {
  const [overview, setOverview] = useState<AdminIntegrationsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void (async () => {
      const accessToken = await getAccessToken();

      if (!accessToken) {
        if (!cancelled) {
          setError("Your session has expired. Please sign in again.");
          setLoading(false);
        }
        return;
      }

      const result = await getAdminIntegrations(accessToken);
      if (cancelled) return;

      if (result.kind === "success") {
        setOverview(result.data);
        setError(null);
      } else if (result.kind === "forbidden") {
        setError("You do not have admin access.");
      } else {
        setError(result.message);
      }

      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return (
    <AdminCard
      title="Integrations"
      description="Whether the server can use each provider. Presence only — values are never sent to the browser."
      action={<RefreshButton onClick={() => setReloadToken((value) => value + 1)} busy={loading} />}
    >
      {error && <SectionMessage tone="error">{error}</SectionMessage>}

      {overview === null && !error && <SectionMessage tone="muted">Loading…</SectionMessage>}

      {overview && (
        <div className="space-y-3">
          {overview.integrations.map((entry) => (
            <IntegrationRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </AdminCard>
  );
}

function IntegrationRow({ entry }: { entry: AdminIntegrationStatus }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-100">{entry.label}</span>
          {entry.configured ? (
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-400">
              Active
            </span>
          ) : (
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-400">
              Not configured
            </span>
          )}
        </div>

        {entry.requiresReview && (
          <span className="rounded bg-sky-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-sky-300">
            Manual intake only — terms review pending
          </span>
        )}
      </div>

      <p className="mt-1 text-xs text-slate-500">{entry.purpose}</p>

      <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
        <Row label="Missing variables" value={entry.missingEnv.length === 0 ? "none" : entry.missingEnv.join(", ")} />
        <Row label="Policy version" value={entry.policyVersion ?? "—"} mono />
        <Row
          label="Discovery allowed"
          value={entry.discoveryAllowed === null ? "—" : entry.discoveryAllowed ? "yes" : "no"}
        />
        <Row label="Kill switch" value={entry.killSwitch === null ? "—" : entry.killSwitch ? "on" : "off"} />
        <Row label="Enabled targets" value={entry.enabledTargets === null ? "—" : String(entry.enabledTargets)} />
      </dl>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className={mono ? "font-mono text-slate-300" : "text-slate-300"}>{value}</dd>
    </div>
  );
}
