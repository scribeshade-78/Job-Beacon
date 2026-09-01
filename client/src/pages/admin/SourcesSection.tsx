import { useEffect, useState } from "react";
import {
  getAdminSources,
  updateAdminSource,
  EDITABLE_SOURCE_POLICY_FIELDS,
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
  );
}
