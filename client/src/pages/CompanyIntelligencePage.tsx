import { CompaniesPanel } from "../panels/CompaniesPanel";
import { CompanyReviewsPanel } from "../panels/CompanyReviewsPanel";
import { NetworkingPanel } from "../panels/NetworkingPanel";
import { SalaryBenchmarksPanel } from "../panels/SalaryBenchmarksPanel";

interface CompanyIntelligencePageProps {
  candidateId: string | undefined;
  ready: boolean;
}

export function CompanyIntelligencePage({ candidateId, ready }: CompanyIntelligencePageProps) {
  return (
    <div className="space-y-6">
      <NetworkingPanel />
      <CompaniesPanel />
      {ready && candidateId && <CompanyReviewsPanel candidateId={candidateId} />}
      <SalaryBenchmarksPanel />
    </div>
  );
}
