import { useEffect, useState } from "react";
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
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

const AUTOMATION_STATUS_BADGE: Record<Authorization["status"], StatusBadgeStatus> = {
  authorized: "automation_active",
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

  return (
    <Card>
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
              Authorize
            </Button>
          </>
        )}

        {authorization && authorization !== "notYetAuthorized" && (
          <>
            <StatusBadge status={AUTOMATION_STATUS_BADGE[authorization.status]} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={busy || authorization.status === "paused"}
                onClick={() => void run((client) => pause(client, candidateId))}
              >
                Pause
              </Button>
              <Button
                variant="secondary"
                disabled={busy || authorization.status !== "paused"}
                onClick={() => void run((client) => resumeAutomation(client, candidateId))}
              >
                Resume
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
