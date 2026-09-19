import { ResumesPanel } from "../panels/ResumesPanel";

/**
 * Task F — ResumeFormattingPanel is deliberately NOT rendered here.
 *
 * Its four controls (font family, font size, alignment, fit-to-one-page) were
 * local React state and nothing else: no value was persisted and none of them
 * reached a generated resume, so every control in that panel looked functional
 * and did nothing. Showing it made the product look further along than it is,
 * which is the failure mode this change removes.
 *
 * The component file is kept rather than deleted, because resume layout is a
 * real planned feature and the panel's own copy already said so. Restore the
 * import and the element below once a document renderer actually consumes these
 * settings — the point is that the UI should not offer them before that exists.
 */
interface ResumesPageProps {
  candidateId: string | undefined;
  ready: boolean;
}

export function ResumesPage({ candidateId, ready }: ResumesPageProps) {
  return (
    <div className="space-y-6">
      {ready && candidateId && <ResumesPanel candidateId={candidateId} />}
    </div>
  );
}
