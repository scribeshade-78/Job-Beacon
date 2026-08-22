import { MailboxPanel } from "../panels/MailboxPanel";
import { MessagesPanel } from "../panels/MessagesPanel";

interface ResponsesPageProps {
  ready: boolean;
}

export function ResponsesPage({ ready }: ResponsesPageProps) {
  return (
    <div className="space-y-6">
      {ready && (
        <>
          <MailboxPanel />
          <MessagesPanel />
        </>
      )}
    </div>
  );
}
