import { ApplicationsPanel } from "../panels/ApplicationsPanel";

interface ApplicationsPageProps {
  ready: boolean;
}

export function ApplicationsPage({ ready }: ApplicationsPageProps) {
  return <div className="space-y-6">{ready && <ApplicationsPanel />}</div>;
}
