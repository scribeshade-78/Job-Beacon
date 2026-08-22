import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { listMessages, type MailboxMessage } from "../lib/mailboxMessages";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

export function MessagesPanel() {
  const [messages, setMessages] = useState<MailboxMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMessages(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setMessages(result.messages);
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle id="messages-title">Messages</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="messages-title">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        {messages?.length === 0 && <p className="text-sm text-ios-text-secondary">No messages yet.</p>}
        <ul className="space-y-3">
          {messages?.map((message) => (
            <li key={message.id} className="border-b border-ios-separator pb-3 text-sm last:border-0 last:pb-0">
              <span className="font-medium text-black">{message.subject ?? "(no subject)"}</span>
              {message.sender && <span className="text-ios-text-secondary"> — {message.sender}</span>}
              {message.receivedAt && <span className="text-ios-text-secondary"> ({message.receivedAt})</span>}
              {(message.classifications.length > 0 || message.interviews.length > 0 || message.actionItems.length > 0) && (
                <ul className="mt-1 space-y-0.5 pl-4 text-ios-text-secondary">
                  {message.classifications.map((classification) => (
                    <li key={classification.id}>Classified: {classification.category}</li>
                  ))}
                  {message.interviews.map((interview) => (
                    <li key={interview.id}>
                      Interview{interview.format && ` (${interview.format})`}
                      {interview.scheduledAt && ` — ${interview.scheduledAt}`}
                    </li>
                  ))}
                  {message.actionItems.map((item) => (
                    <li key={item.id}>
                      Action needed: {item.itemType} — {item.status}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
