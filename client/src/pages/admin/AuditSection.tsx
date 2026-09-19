import { Fragment, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  listAuditEvents,
  listSecurityEvents,
  type AuditEventRecord,
  type SecurityEventRecord,
  type SecuritySeverity,
} from "../../lib/audit";
import { AdminCard, SectionMessage, getAccessToken } from "./shared";

/**
 * Task H4 — "Audit Log", wired to real tables.
 *
 * This replaces AuditLogMock, which rendered two invented rows under a "Mock
 * data" badge. There is no badge here and no placeholder row: everything below
 * is a row of audit_events or security_events, and both cards render an
 * explicit empty state rather than an empty table.
 *
 * WHAT THE TWO TABLES ARE, STATED PLAINLY, because the difference matters to
 * whoever reads this screen:
 *
 *   audit_events is APPEND-ONLY (PRD v3 §21.1 Audit domain). service_role holds
 *   INSERT and SELECT and nothing else, so no code path can rewrite history —
 *   §21.2's "corrections create new versions" is only checkable because the
 *   previous state survives in the row that recorded the change. That is also
 *   why previous/new values are shown rather than diffed away: a row saying
 *   "decision changed" without saying what it changed FROM cannot answer the
 *   only question anyone asks an audit log.
 *
 *   security_events is the detections from the untrusted-content defences RI PRD
 *   §10.3 requires. They are written to a table rather than logged so that "has
 *   anything tried to make our model exfiltrate a token?" is a queryable fact —
 *   a sanitizer that silently rewrites text is indistinguishable from one that
 *   is not running.
 *
 * THE TWO FETCHES FAIL INDEPENDENTLY on purpose. One route being down must not
 * blank the other table, and an empty audit trail must never read as "no
 * security events have ever been recorded".
 */

const SEVERITY_CLASS: Record<SecuritySeverity, string> = {
  high: "bg-rose-500/20 text-rose-300",
  medium: "bg-amber-500/20 text-amber-300",
  low: "bg-slate-800 text-slate-400",
};

/**
 * Times are shown in the reader's locale (matching TrustScoringSection) with the
 * raw stored value one hover away: locale output drops the offset, and for an
 * audit row the exact instant is the part that has to be defensible.
 */
function When({ value }: { value: string }) {
  return (
    <span title={value} className="font-mono text-xs text-slate-400">
      {new Date(value).toLocaleString()}
    </span>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <pre className="mt-1 max-h-48 overflow-auto rounded border border-slate-800 bg-slate-950/60 p-2 font-mono text-xs text-slate-300">
        {JSON.stringify(value ?? null, null, 2)}
      </pre>
    </div>
  );
}

function AuditRow({ event }: { event: AuditEventRecord }) {
  const [expanded, setExpanded] = useState(false);

  const previousValues = event.previousValues ?? null;
  const newValues = event.newValues ?? null;
  // Half the trail has no before/after at all (a creation, a plain read-backed
  // action), so the toggle only exists where there is something behind it —
  // an expander that opens onto nothing trains people to stop clicking.
  const hasDiff = previousValues !== null || newValues !== null;

  return (
    <Fragment>
      <tr className="border-b border-slate-900 align-top">
        <td className="py-2 pr-2">
          {hasDiff && (
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              aria-expanded={expanded}
              aria-label={expanded ? "Hide previous and new values" : "Show previous and new values"}
              className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-800/60 hover:text-slate-300"
            >
              <ChevronRight
                className={"h-3.5 w-3.5 transition-transform " + (expanded ? "rotate-90" : "")}
                aria-hidden="true"
              />
            </button>
          )}
        </td>
        <td className="py-2 pr-4">
          <When value={event.occurredAt} />
        </td>
        <td className="py-2 pr-4">
          {/* NULL actor_id is the schema's way of saying the system did it, so it
              is spelled "system" rather than left blank — a blank cell reads as
              missing data, which is a different and more alarming thing. */}
          <span className="break-all font-mono text-xs text-slate-300">{event.actorId ?? "system"}</span>
          <span className="ml-1 text-xs text-slate-500">{event.actorRole}</span>
        </td>
        <td className="py-2 pr-4">
          <span className="break-all font-mono text-xs text-slate-300">{event.action}</span>
        </td>
        <td className="py-2 pr-4">
          <span className="break-all font-mono text-xs text-slate-400">{event.entityType}</span>
          {event.entityId && <span className="break-all font-mono text-xs text-slate-500"> {event.entityId}</span>}
        </td>
        <td className="py-2 pr-4 text-xs text-slate-300">{event.summary}</td>
      </tr>

      {expanded && (
        <tr className="border-b border-slate-900 bg-slate-950/40">
          <td colSpan={6} className="px-2 py-3">
            <div className="space-y-3">
              <p className="text-xs text-slate-300">{event.summary}</p>
              {/* An absent reason is stated, not omitted: "no reason recorded" is
                  itself an audit finding, and a missing line is not. */}
              <p className="text-xs text-slate-500">
                Reason: {event.reason ?? "none recorded"}
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                <JsonBlock label="Previous values" value={previousValues} />
                <JsonBlock label="New values" value={newValues} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function AuditSection() {
  const [events, setEvents] = useState<AuditEventRecord[] | null>(null);
  const [securityEvents, setSecurityEvents] = useState<SecurityEventRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [securityError, setSecurityError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        if (!cancelled) {
          setError("Your session has expired.");
          setSecurityError("Your session has expired.");
        }
        return;
      }

      const [auditResult, securityResult] = await Promise.all([
        listAuditEvents(accessToken),
        listSecurityEvents(accessToken),
      ]);
      if (cancelled) return;

      if (auditResult.kind === "success") {
        setEvents(auditResult.data.events);
        setError(null);
      } else if (auditResult.kind === "forbidden") {
        setError("You don't have admin access.");
      } else {
        setError(auditResult.message);
      }

      if (securityResult.kind === "success") {
        setSecurityEvents(securityResult.data.events);
        setSecurityError(null);
      } else if (securityResult.kind === "forbidden") {
        setSecurityError("You don't have admin access.");
      } else {
        setSecurityError(securityResult.message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      <AdminCard
        title="Audit trail"
        description="Newest first, from audit_events. Append-only: service_role can INSERT and SELECT and nothing else, so a row here cannot have been rewritten after the fact (PRD v3 §21.1; the previous/new values below are what makes §21.2's corrections-creates-new-versions checkable)."
      >
        {error && <SectionMessage tone="error">{error}</SectionMessage>}

        {events === null ? (
          <SectionMessage tone="muted">Loading…</SectionMessage>
        ) : events.length === 0 ? (
          <SectionMessage tone="muted">No audit events recorded yet.</SectionMessage>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-2 font-medium">
                    <span className="sr-only">Diff</span>
                  </th>
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Actor</th>
                  <th className="py-2 pr-4 font-medium">Action</th>
                  <th className="py-2 pr-4 font-medium">Entity</th>
                  <th className="py-2 pr-4 font-medium">Summary</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <AuditRow key={event.id} event={event} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      <AdminCard
        title="Security events"
        description="Detections from the untrusted-content defences (RI PRD §10.3): injected instructions in email, job descriptions and web pages, stripped active HTML and tracking pixels, disallowed link schemes. Also append-only. Written to a table rather than logged, so a refusal is visible — a sanitizer that rewrites text silently looks exactly like one that is not running."
      >
        {securityError && <SectionMessage tone="error">{securityError}</SectionMessage>}

        {securityEvents === null ? (
          <SectionMessage tone="muted">Loading…</SectionMessage>
        ) : securityEvents.length === 0 ? (
          <SectionMessage tone="muted">
            No security events recorded. Nothing has been detected since these defences were switched on — which is not
            the same as nothing having been attempted.
          </SectionMessage>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Event</th>
                  <th className="py-2 pr-4 font-medium">Severity</th>
                  <th className="py-2 pr-4 font-medium">Source</th>
                  <th className="py-2 pr-4 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {securityEvents.map((event) => (
                  <tr key={event.id} className="border-b border-slate-900 align-top">
                    <td className="py-2 pr-4">
                      <When value={event.occurredAt} />
                    </td>
                    <td className="py-2 pr-4">
                      <span className="break-all font-mono text-xs text-slate-300">{event.eventType}</span>
                    </td>
                    <td className="py-2 pr-4">
                      {/* The word carries the meaning and the colour reinforces
                          it — severity must survive a reader who cannot see it. */}
                      <span
                        className={
                          "rounded px-2 py-1 text-xs font-semibold uppercase " + SEVERITY_CLASS[event.severity]
                        }
                      >
                        {event.severity}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <span className="font-mono text-xs text-slate-400">{event.source}</span>
                    </td>
                    <td className="py-2 pr-4">
                      {event.detail === null ? (
                        <span className="text-xs text-slate-500">—</span>
                      ) : (
                        <pre className="max-h-32 max-w-[320px] overflow-auto whitespace-pre-wrap break-all rounded border border-slate-800 bg-slate-950/60 p-2 font-mono text-[11px] text-slate-400">
                          {JSON.stringify(event.detail, null, 2)}
                        </pre>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>
    </div>
  );
}
