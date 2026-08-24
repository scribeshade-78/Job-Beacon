import { TargetRolesPanel } from "../panels/TargetRolesPanel";

interface TargetRolesPageProps {
  candidateId: string | undefined;
  ready: boolean;
}

export function TargetRolesPage({ candidateId, ready }: TargetRolesPageProps) {
  return <div className="space-y-6">{ready && candidateId && <TargetRolesPanel candidateId={candidateId} />}</div>;
}
