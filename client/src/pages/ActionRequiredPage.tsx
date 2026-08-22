import { ActionRequiredPanel } from "../panels/ActionRequiredPanel";

interface ActionRequiredPageProps {
  ready: boolean;
}

export function ActionRequiredPage({ ready }: ActionRequiredPageProps) {
  return <div className="space-y-6">{ready && <ActionRequiredPanel />}</div>;
}
