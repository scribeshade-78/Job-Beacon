import { OpportunitiesPanel } from "../panels/OpportunitiesPanel";

interface OpportunitiesPageProps {
  /**
   * Passed straight through to the panel, which reads the candidate's saved
   * preferences to seed its filter state (Task I). Same threading as
   * TargetRolesPage and ProfilePage.
   */
  candidateId: string | undefined;
}

export function OpportunitiesPage({ candidateId }: OpportunitiesPageProps) {
  return <OpportunitiesPanel candidateId={candidateId} />;
}
