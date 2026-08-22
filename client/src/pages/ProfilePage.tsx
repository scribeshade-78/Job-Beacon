import { ExclusionsPanel } from "../panels/ExclusionsPanel";

interface ProfilePageProps {
  candidateId: string | undefined;
  ready: boolean;
}

export function ProfilePage({ candidateId, ready }: ProfilePageProps) {
  return <div className="space-y-6">{ready && candidateId && <ExclusionsPanel candidateId={candidateId} />}</div>;
}
