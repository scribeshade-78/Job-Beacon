import { ApplicationPreferencesPanel } from "../panels/ApplicationPreferencesPanel";
import { CandidatePreferencesPanel } from "../panels/CandidatePreferencesPanel";
import { ExclusionsPanel } from "../panels/ExclusionsPanel";
import { IntegrationsPanel } from "../panels/IntegrationsPanel";

interface ProfilePageProps {
  candidateId: string | undefined;
  ready: boolean;
}

export function ProfilePage({ candidateId, ready }: ProfilePageProps) {
  return (
    <div className="space-y-6">
      {/* job preferences before application preferences: the first describes
          what the candidate wants, the second how applications are executed,
          and Task I's filters are seeded from the first. */}
      {ready && candidateId && (
        <>
          <CandidatePreferencesPanel candidateId={candidateId} />
          <ApplicationPreferencesPanel candidateId={candidateId} />
          <IntegrationsPanel />
          <ExclusionsPanel candidateId={candidateId} />
        </>
      )}
    </div>
  );
}
