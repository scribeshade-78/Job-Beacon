import { useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { EmptyState } from "../components/ui/empty-state";
import { listMessages } from "../lib/mailboxMessages";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { groupMessagesForToday, type DeadlineUrgency, type TodaySection } from "../lib/todayDashboard";

function receivedLabel(receivedAt: string | null): string | null {
  if (!receivedAt) {
    return null;
  }
  const date = new Date(receivedAt);
  return Number.isNaN(date.getTime()) ? null : formatDistanceToNow(date, { addSuffix: true });
}

const DEADLINE_CLASS: Record<DeadlineUrgency, string> = {
  overdue: "text-status-blocked-fg font-medium",
  soon: "text-status-blocked-fg font-medium",
  later: "text-ios-text-secondary",
};

export function TodayPanel() {
  const [sections, setSections] = useState<TodaySection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMessages(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setSections(groupMessagesForToday(result.messages));
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle id="today-title">Today</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="today-title" className="space-y-6">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}

        {sections?.length === 0 && (
          <EmptyState
            icon={Inbox}
            title="Nothing to catch up on"
            description="Classified messages from your connected mailbox will show up here, grouped by what needs your attention."
          />
        )}

        {sections?.map((section) => (
          <section
            key={section.key}
            aria-labelledby={`today-section-${section.key}`}
            className={section.key === "rejections" ? "opacity-70" : undefined}
          >
            <h3 id={`today-section-${section.key}`} className="mb-2 text-sm font-semibold text-black">
              {section.title} <span className="font-normal text-ios-text-secondary">({section.items.length})</span>
            </h3>
            <ul className="space-y-3">
              {section.items.map((item) => {
                const entities = [item.company, item.role, item.jobId ? `#${item.jobId}` : null].filter(Boolean);
                return (
                  <li key={item.messageId} className="rounded-control border border-ios-separator p-4">
                    <p className="font-medium text-black">{item.subject ?? "(no subject)"}</p>
                    <p className="text-sm text-ios-text-secondary">
                      {item.sender ?? "Unknown sender"}
                      {receivedLabel(item.receivedAt) && <> · {receivedLabel(item.receivedAt)}</>}
                    </p>
                    {entities.length > 0 && <p className="mt-1 text-sm text-black">{entities.join("  ·  ")}</p>}
                    {item.deadline && (
                      <p className={`mt-1 text-sm ${DEADLINE_CLASS[item.deadlineUrgency ?? "later"]}`}>
                        Due {item.deadline}
                      </p>
                    )}
                    {item.salaryText && <p className="mt-1 text-sm text-ios-text-secondary">{item.salaryText}</p>}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
