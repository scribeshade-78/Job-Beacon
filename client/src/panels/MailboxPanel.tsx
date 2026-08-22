import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { listMailboxConnections, type MailboxConnection } from "../lib/mailbox";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

const MAILBOX_PROVIDER_LABELS: Record<MailboxConnection["provider"], string> = {
  gmail: "Gmail",
  outlook: "Outlook",
};

export function MailboxPanel() {
  const [connections, setConnections] = useState<MailboxConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMailboxConnections(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setConnections(result.connections);
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle id="mailbox-title">Mailbox</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="mailbox-title">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        {connections?.length === 0 && <p className="text-sm text-ios-text-secondary">No mailbox connected yet.</p>}
        <ul className="space-y-2">
          {connections?.map((connection) => (
            <li key={connection.id} className="text-sm text-black">
              {MAILBOX_PROVIDER_LABELS[connection.provider]} — {connection.status}
              {connection.connectedAt && ` (connected ${connection.connectedAt})`}
              {connection.revokedAt && ` (revoked ${connection.revokedAt})`}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
