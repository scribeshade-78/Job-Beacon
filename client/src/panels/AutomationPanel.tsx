import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { StatusBadge, type StatusBadgeStatus } from "../components/ui/status-badge";
import {
  authorize,
  CONSENT_DISCLOSURE,
  getAuthorization,
  pause,
  resume as resumeAutomation,
  stop,
  type Authorization,
} from "../lib/automationAuthorization";
import { listSelectedRoles, type SelectedRole } from "../lib/candidateSelectedRoles";
import {
  describeAutomationCapabilityNotice,
  fetchQueueCapability,
  type QueueCapabilityState,
} from "../lib/queueCapability";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { AUTOMATION_CONSENT_ANCHOR_ID } from "../lib/readiness";

/**
 * CONSENT STATE, AND NOTHING MORE.
 *
 * These map automation_authorizations.status — what the candidate agreed to —
 * onto a badge. "authorized" deliberately reads "Authorized" rather than
 * "Active": authorizing records consent, and consent alone does not mean
 * automation is running. Whether work can actually run is a separate,
 * source-level question answered by the capability notice below. Paused and
 * Stopped are unchanged because they describe the consent record accurately.
 */
const AUTOMATION_STATUS_BADGE: Record<Authorization["status"], StatusBadgeStatus> = {
  authorized: "automation_authorized",
  paused: "automation_paused",
  stopped: "automation_stopped",
};

interface AutomationPanelProps {
  candidateId: string;
}

export function AutomationPanel({ candidateId }: AutomationPanelProps) {
  const [authorization, setAuthorization] = useState<Authorization | "notYetAuthorized" | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<SelectedRole[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  /** Whether any source can carry an application, read from the server. */
  const [capability, setCapability] = useState<QueueCapabilityState>({ kind: "loading" });

  const loadCapability = useCallback(async () => {
    setCapability({ kind: "loading" });
    setCapability(await fetchQueueCapability());
  }, []);

  useEffect(() => {
    void loadCapability();
  }, [loadCapability]);

  async function refresh() {
    const client = getSupabaseBrowserClient();
    const [authResult, rolesResult] = await Promise.all([getAuthorization(client), listSelectedRoles(client)]);

    if (authResult.kind === "authorized") {
      setAuthorization(authResult.authorization);
    } else if (authResult.kind === "notYetAuthorized") {
      setAuthorization("notYetAuthorized");
    } else {
      setError(authResult.message);
    }

    if (rolesResult.kind === "success") {
      setSelectedRoles(rolesResult.roles);
    } else {
      setError(rolesResult.message);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action: (client: ReturnType<typeof getSupabaseBrowserClient>) => Promise<{ kind: string; message?: string }>) {
    setBusy(true);
    setError(null);
    const result = await action(getSupabaseBrowserClient());

    if (result.kind === "error" && result.message) {
      setError(result.message);
      setBusy(false);
      return;
    }

    await refresh();
    setBusy(false);
  }

  const automationCapabilityNotice = describeAutomationCapabilityNotice(capability);

  return (
    <Card id={AUTOMATION_CONSENT_ANCHOR_ID}>
      <CardHeader>
        <CardTitle id="automation-title">Automation</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="automation-title" className="space-y-4">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}

        <div>
          <h3 className="text-sm font-medium text-black">Selected roles</h3>
          {selectedRoles === null ? null : selectedRoles.length === 0 ? (
            <p className="text-sm text-ios-text-secondary">
              No target roles selected yet — automation has nothing to act on until you select at least one.
            </p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Selected roles">
              {selectedRoles.map((role) => (
                <li
                  key={role.id}
                  className="rounded-control bg-ios-bg px-2.5 py-1 text-sm text-black"
                >
                  {role.roleName}
                </li>
              ))}
            </ul>
          )}
        </div>

        {authorization === "notYetAuthorized" && (
          <>
            <ul className="space-y-1 text-sm text-ios-text-secondary">
              {CONSENT_DISCLOSURE.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <Button disabled={busy} onClick={() => void run((client) => authorize(client, candidateId))}>
              Grant submission consent
            </Button>
          </>
        )}

        {authorization && authorization !== "notYetAuthorized" && (
          <>
            <StatusBadge status={AUTOMATION_STATUS_BADGE[authorization.status]} />

            {/* SEPARATE FROM THE BADGE, ON PURPOSE. The badge reports the
                candidate's consent; this reports whether the product can act on
                it. Showing "no source supports queueing" as a red/blocked state
                would read as the candidate's own fault or as lost consent, so it
                is neutral and says explicitly that the authorization is kept. */}
            {automationCapabilityNotice && (
              <p
                role={capability.kind === "error" ? "alert" : "status"}
                className="rounded border border-ios-separator bg-ios-bg px-3 py-2 text-xs text-ios-text-secondary"
              >
                {automationCapabilityNotice}{" "}
                {capability.kind === "error" && (
                  <button
                    type="button"
                    onClick={() => void loadCapability()}
                    className="font-medium text-ios-blue hover:underline"
                  >
                    Retry
                  </button>
                )}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {/* Pause is offered only while it is actually running. The old
                  condition (status === "paused") left it clickable on a STOPPED
                  authorization, where pausing is meaningless — and worse, that
                  click round-tripped the status to "paused" purely to make
                  Resume available again. */}
              <Button
                variant="secondary"
                disabled={busy || authorization.status !== "authorized"}
                onClick={() => void run((client) => pause(client, candidateId))}
              >
                Pause
              </Button>
              {/* Enabled when paused OR stopped.
                  THE BUG THIS FIXES: with `status !== "paused"`, a stopped
                  authorization had Resume disabled and Stop disabled, so there
                  was no way back at all — the dead state. Stop is the
                  withdrawal path, not terminal: nothing in the schema or in
                  setStatus prevents returning to authorized. The label follows
                  the state so a stopped candidate is offered "Start" rather
                  than "Resume", which would read as resuming something that was
                  never paused. */}
              <Button
                variant="secondary"
                disabled={busy || (authorization.status !== "paused" && authorization.status !== "stopped")}
                onClick={() => void run((client) => resumeAutomation(client, candidateId))}
              >
                {authorization.status === "stopped" ? "Start" : "Resume"}
              </Button>
              <Button
                variant="destructive"
                disabled={busy || authorization.status === "stopped"}
                onClick={() => void run((client) => stop(client, candidateId))}
              >
                Stop
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
