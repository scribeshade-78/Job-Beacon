import { CompaniesPanel } from "../panels/CompaniesPanel";
import { SalaryBenchmarksPanel } from "../panels/SalaryBenchmarksPanel";

export function CompanyIntelligencePage() {
  return (
    <div className="space-y-6">
      <CompaniesPanel />
      <SalaryBenchmarksPanel />
    </div>
  );
}
