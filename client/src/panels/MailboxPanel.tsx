import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import {
  disconnectMailboxConnection,
  listMailboxConnections,
  startMailboxConnect,
  type MailboxConnection,
} from "../lib/mailbox";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

const MAILBOX_PROVIDER_LABELS: Record<MailboxConnection["provider"], string> = {
  gmail: "Gmail",
  outlook: "Outlook",
};

async function getAccessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * The OAuth callback (server-side, GET /api/mailbox/oauth/callback) redirects
 * here with ?mailbox=connected|error — read once on mount, then stripped
 * from the URL so a page refresh doesn't replay the same notice.
 */
function readAndClearMailboxCallbackParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("mailbox");

  if (status) {
    const url = new URL(window.location.href);
    url.searchParams.delete("mailbox");
    window.history.replaceState({}, "", url.toString());
  }

  return status;
}

export function MailboxPanel() {
  const [connections, setConnections] = useState<MailboxConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [callbackNotice, setCallbackNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | "connecting" | null>(null);

  function reload() {
    listMailboxConnections(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setConnections(result.connections);
      } else {
        setError(result.message);
      }
    });
  }

  useEffect(() => {
    reload();

    const status = readAndClearMailboxCallbackParam();
    if (status === "connected") {
      setCallbackNotice("Mailbox connected.");
    } else if (status === "error") {
      setCallbackNotice("Could not connect your mailbox. Please try again.");
    }
  }, []);

  async function handleConnect() {
    setActionError(null);
    setBusyId("connecting");

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setActionError("You must be signed in to connect a mailbox.");
      setBusyId(null);
      return;
    }

    const result = await startMailboxConnect(accessToken);
    if (result.kind === "error") {
      setActionError(result.message);
      setBusyId(null);
      return;
    }

    window.location.href = result.authorizeUrl;
  }

  async function handleDisconnect(connectionId: string) {
    setActionError(null);
    setBusyId(connectionId);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setActionError("You must be signed in to disconnect a mailbox.");
      setBusyId(null);
      return;
    }

    const result = await disconnectMailboxConnection(connectionId, accessToken);
    if (result.kind === "error") {
      setActionError(result.message);
    } else {
      reload();
    }
    setBusyId(null);
  }

  const hasConnectedGmail = connections?.some((c) => c.provider === "gmail" && c.status === "connected") ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle id="mailbox-title">Mailbox</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="mailbox-title" className="space-y-3">
        {callbackNotice && (
          <p role="status" className="text-sm text-ios-text-secondary">
            {callbackNotice}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        {actionError && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {actionError}
          </p>
        )}
        {connections?.length === 0 && <p className="text-sm text-ios-text-secondary">No mailbox connected yet.</p>}
        <ul className="space-y-2">
          {connections?.map((connection) => (
            <li key={connection.id} className="flex items-center justify-between gap-2 text-sm text-black">
              <span>
                {MAILBOX_PROVIDER_LABELS[connection.provider]}
                {connection.emailAddress && ` — ${connection.emailAddress}`} — {connection.status}
                {connection.connectedAt && ` (connected ${connection.connectedAt})`}
                {connection.revokedAt && ` (revoked ${connection.revokedAt})`}
              </span>
              {connection.status === "connected" && (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busyId === connection.id}
                  onClick={() => void handleDisconnect(connection.id)}
                >
                  {busyId === connection.id ? "Disconnecting…" : "Disconnect"}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {!hasConnectedGmail && (
          <Button disabled={busyId === "connecting"} onClick={() => void handleConnect()}>
            {busyId === "connecting" ? "Redirecting…" : "Connect Gmail"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
