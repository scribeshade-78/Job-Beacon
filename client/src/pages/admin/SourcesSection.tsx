import { useEffect, useState } from "react";
import {
  getAdminSources,
  getAdminSourceHealth,
  updateAdminSource,
  EDITABLE_SOURCE_POLICY_FIELDS,
  type SourceHealthList,
  type SourceHealthStatus,
  type SourcePolicy,
  type EditableSourcePolicyField,
} from "../../lib/admin";
import { AdminCard, SectionMessage, getAccessToken } from "./shared";

const FIELD_LABELS: Record<EditableSourcePolicyField, string> = {
  discovery_allowed: "Discovery",
  storage_allowed: "Storage",
  display_allowed: "Display",
  automated_application_allowed: "Auto-apply",
  kill_switch: "Kill switch",
};

const SELECT_CLASS =
  "mt-1 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200";

/** The windows on offer. The server clamps to its own 1..500 range regardless. */
const HEALTH_LIMITS = [50, 100, 250, 500] as const;

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "—";
  }

  return durationMs >= 1000 ? (durationMs / 1000).toFixed(1) + " s" : durationMs + " ms";
}

function HealthStatusBadge({ status }: { status: SourceHealthStatus }) {
  return <span className={status === "error" ? "text-rose-400" : "text-emerald-300"}>{status}</span>;
}

function Timestamp({ value }: { value: string }) {
  // Raw value on hover: the locale rendering drops the offset, and "when did
  // this source last run" is a question about the stored instant.
  return (
    <span title={value} className="font-mono text-xs text-slate-400">
      {new Date(value).toLocaleString()}
    </span>
  );
}

export function SourcesSection() {
  const [sources, setSources] = useState<SourcePolicy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  async function load() {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      return;
    }

    const result = await getAdminSources(accessToken);
    if (result.kind === "success") {
      setSources(result.data);
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

  async function toggle(source: SourcePolicy, field: EditableSourcePolicyField) {
    const key = `${source.source_code}:${field}`;
    setSavingKey(key);
    setError(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setSavingKey(null);
      return;
    }

    const result = await updateAdminSource(source.source_code, { [field]: !source[field] }, accessToken);
    if (result.kind === "success") {
      setSources((current) =>
        (current ?? []).map((row) => (row.source_code === source.source_code ? result.data : row)),
      );
    } else if (result.kind === "forbidden") {
      setError("You don't have admin access.");
    } else {
      setError(result.message);
    }

    setSavingKey(null);
  }

  return (
    // Two cards, two independent reads: a health failure must not hide the
    // policy toggles an operator may be reaching for to stop a bad source, and
    // a policy failure must not hide the evidence of why.
    <div className="space-y-4">
      <AdminCard title="Sources & ingestion" description="One row per provider in source_policies. Toggles write straight back through PATCH /api/admin/sources/:sourceCode.">
        {error && <SectionMessage tone="error">{error}</SectionMessage>}

        {sources === null ? (
          <SectionMessage tone="muted">Loading…</SectionMessage>
        ) : sources.length === 0 ? (
          <SectionMessage tone="muted">No source policies configured.</SectionMessage>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4 font-medium">Source</th>
                  <th className="py-2 pr-4 font-medium">Auth</th>
                  <th className="py-2 pr-4 font-medium">Policy</th>
                  {EDITABLE_SOURCE_POLICY_FIELDS.map((field) => (
                    <th key={field} className="py-2 pr-4 font-medium">
                      {FIELD_LABELS[field]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.source_code} className="border-b border-slate-900">
                    <td className="py-2 pr-4 font-mono text-xs text-slate-300">{source.source_code}</td>
                    <td className="py-2 pr-4 text-xs text-slate-400">{source.authentication_method}</td>
                    <td className="py-2 pr-4 text-xs text-slate-400">{source.policy_version}</td>
                    {EDITABLE_SOURCE_POLICY_FIELDS.map((field) => {
                      const key = `${source.source_code}:${field}`;
                      const on = source[field];
                      return (
                        <td key={field} className="py-2 pr-4">
                          <button
                            type="button"
                            disabled={savingKey === key}
                            onClick={() => void toggle(source, field)}
                            aria-pressed={on}
                            className={`rounded px-2 py-1 text-xs font-semibold transition-colors disabled:opacity-40 ${
                              on
                                ? field === "kill_switch"
                                  ? "bg-rose-500/20 text-rose-300"
                                  : "bg-emerald-500/20 text-emerald-300"
                                : "bg-slate-800 text-slate-500"
                            }`}
                          >
                            {on ? "On" : "Off"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      <SourceHealthCard sourceCodes={(sources ?? []).map((source) => source.source_code)} />
    </div>
  );
}

/**
 * The per-run fetch log from public.source_health_events, read through
 * GET /api/admin/source-health.
 *
 * WHAT IT CAN AND CANNOT ANSWER, stated here because the table shape is the
 * limit: a rate limit IS visible, as an error whose message names the HTTP
 * status, and an adapter refusal (Jooble requiring keywords, for instance) is
 * visible for the same reason. A source refused BEFORE its fetch — kill switch
 * on, discovery disabled, no policy row — writes no row at all, so no window
 * size will surface it. Both notes are repeated under the table.
 *
 * Fetched independently of the policy table above so one read failing leaves
 * the other usable.
 */
function SourceHealthCard({ sourceCodes }: { sourceCodes: string[] }) {
  const [health, setHealth] = useState<SourceHealthList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceCode, setSourceCode] = useState("");
  const [status, setStatus] = useState<"" | SourceHealthStatus>("");
  const [limit, setLimit] = useState<number>(100);

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

      const result = await getAdminSourceHealth(
        {
          limit,
          sourceCode: sourceCode === "" ? undefined : sourceCode,
          status: status === "" ? undefined : status,
        },
        accessToken,
      );

      if (cancelled) {
        return;
      }

      if (result.kind === "success") {
        setHealth(result.data);
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
  }, [sourceCode, status, limit]);

  // The policy table's own source codes plus whatever this window contained, so
  // the filter still offers real sources when the policy read failed.
  const options = Array.from(
    new Set([...sourceCodes, ...(health?.sources ?? []).map((entry) => entry.sourceCode)]),
  ).sort();

  return (
    <AdminCard
      title="Source health"
      description="One row per source fetch, written by the on-demand intake path and the scheduled worker. Read-only — source_health_events grants SELECT and INSERT only."
    >
      {error && <SectionMessage tone="error">{error}</SectionMessage>}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-400">
          Source
          <select value={sourceCode} onChange={(event) => setSourceCode(event.target.value)} className={SELECT_CLASS}>
            <option value="">All sources</option>
            {options.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs text-slate-400">
          Status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as "" | SourceHealthStatus)}
            className={SELECT_CLASS}
          >
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
          </select>
        </label>

        <label className="text-xs text-slate-400">
          Window
          <select value={limit} onChange={(event) => setLimit(Number(event.target.value))} className={SELECT_CLASS}>
            {HEALTH_LIMITS.map((value) => (
              <option key={value} value={value}>
                Newest {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!error && health === null && <p className="mt-4 text-sm text-slate-500">Loading…</p>}

      {health && health.sources.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">No fetch runs in this window.</p>
      )}

      {health && health.sources.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Latest run per source</h3>
          <table className="mt-2 w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-4 font-medium">Source</th>
                <th className="py-2 pr-4 font-medium">Latest run in window</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Fetched</th>
                <th className="py-2 pr-4 font-medium">Duration</th>
                <th className="py-2 pr-4 font-medium">Errors / rows</th>
              </tr>
            </thead>
            <tbody>
              {health.sources.map((entry) => (
                <tr key={entry.sourceCode} className="border-b border-slate-900">
                  <td className="py-2 pr-4 font-mono text-xs text-slate-300">{entry.sourceCode}</td>
                  <td className="py-2 pr-4">
                    <Timestamp value={entry.latestRunAt} />
                  </td>
                  <td className="py-2 pr-4 text-xs">
                    <HealthStatusBadge status={entry.latestStatus} />
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-400">{entry.latestVacanciesFetched}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-400">{formatDuration(entry.latestDurationMs)}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-400">
                    {entry.errorsInWindow} / {entry.eventsInWindow}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {health && health.events.length > 0 && (
        <div className="mt-5 overflow-x-auto">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Runs in this window ({health.events.length})
          </h3>
          <table className="mt-2 w-full min-w-[840px] border-collapse text-left">
            <thead>
              <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-4 font-medium">Run at</th>
                <th className="py-2 pr-4 font-medium">Source</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Fetched</th>
                <th className="py-2 pr-4 font-medium">Duration</th>
                <th className="py-2 pr-4 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {health.events.map((event) => (
                <tr key={event.id} className="border-b border-slate-900 align-top">
                  <td className="py-2 pr-4">
                    <Timestamp value={event.runAt} />
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-300">{event.sourceCode}</td>
                  <td className="py-2 pr-4 text-xs">
                    <HealthStatusBadge status={event.status} />
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-400">{event.vacanciesFetched}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-400">{formatDuration(event.durationMs)}</td>
                  <td className="max-w-[420px] py-2 pr-4 text-xs text-slate-400">
                    {event.errorMessage ? (
                      <span className="break-words" title={event.errorMessage}>
                        {event.errorMessage}
                      </span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {health?.truncated && (
        <p className="mt-3 text-xs text-amber-400">
          Older runs exist beyond this window of {health.limit}. Raise it to see them.
        </p>
      )}

      <p className="mt-3 text-xs text-slate-500">
        The summary counts only the rows loaded below, not all history, so a source whose last run falls outside the
        window has no row here.
      </p>
      <p className="mt-2 text-xs text-slate-500">
        A source refused before its fetch — kill switch on, discovery disabled, or no policy row — writes no row here and
        cannot appear in this table. A rate limit does appear, as an error whose message names the HTTP status.
      </p>
    </AdminCard>
  );
}
