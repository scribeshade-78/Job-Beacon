import { Inbox } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { EmptyState } from "../components/ui/empty-state";
import { AutomationPanel } from "../panels/AutomationPanel";
import { ActionRequiredPanel } from "../panels/ActionRequiredPanel";

const STATS = [
  "Applications submitted",
  "Awaiting response",
  "Interviews scheduled",
  "Action required",
];

interface OverviewPageProps {
  candidateId: string | undefined;
  ready: boolean;
}

export function OverviewPage({ candidateId, ready }: OverviewPageProps) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <div className="lg:col-span-4">{ready && candidateId && <AutomationPanel candidateId={candidateId} />}</div>

      <div className="lg:col-span-8">
        <Card>
          <CardHeader>
            <CardTitle>At a glance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {STATS.map((label) => (
                <div key={label} className="rounded-control border border-ios-separator p-4 text-center">
                  <p className="text-2xl font-bold text-ios-text-secondary">—</p>
                  <p className="mt-1 text-xs text-ios-text-secondary">{label}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="lg:col-span-8">
        <Card>
          <CardHeader>
            <CardTitle>Recent applications</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              icon={Inbox}
              title="No recent applications yet"
              description="This list isn't wired up yet — check the Applications page for your full history."
            />
          </CardContent>
        </Card>
      </div>

      <div className="lg:col-span-4">{ready && <ActionRequiredPanel />}</div>
    </div>
  );
}
