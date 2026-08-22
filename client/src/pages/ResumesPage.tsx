import { ResumesPanel } from "../panels/ResumesPanel";

interface ResumesPageProps {
  candidateId: string | undefined;
  ready: boolean;
}

export function ResumesPage({ candidateId, ready }: ResumesPageProps) {
  return <div className="space-y-6">{ready && candidateId && <ResumesPanel candidateId={candidateId} />}</div>;
}
