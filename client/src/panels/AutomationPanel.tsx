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
  const [error, setError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);

  async function refresh() {
    const result = await getAuthorization(getSupabaseBrowserClient());

    if (result.kind === "authorized") {
      setAuthorization(result.authorization);
    } else if (result.kind === "notYetAuthorized") {
      setAuthorization("notYetAuthorized");
    } else {
      setError(result.message);
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
