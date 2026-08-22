import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { listVerifiedCompanies, type CompanyIntelligenceEntry } from "../lib/companyIntelligence";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

export function CompaniesPanel() {
  const [companies, setCompanies] = useState<CompanyIntelligenceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listVerifiedCompanies(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setCompanies(result.companies);
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle id="companies-title">Verified Companies</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="companies-title">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        {companies?.length === 0 && <p className="text-sm text-ios-text-secondary">No verified company profiles yet.</p>}
        <ul className="space-y-4">
          {companies?.map((company) => (
            <li key={company.companyId} className="border-b border-ios-separator pb-4 text-sm last:border-0 last:pb-0">
              <strong className="text-black">{company.displayedName}</strong>
              {company.domain && <span className="text-ios-text-secondary"> — {company.domain}</span>}
              <ul className="mt-1 space-y-0.5 pl-4 text-ios-text-secondary">
                {company.profile.industry && <li>Industry: {company.profile.industry}</li>}
                {company.profile.headquartersCountry && <li>Headquarters: {company.profile.headquartersCountry}</li>}
                {company.profile.employeeSizeRange && <li>Employees: {company.profile.employeeSizeRange}</li>}
                {company.profile.foundedYear && <li>Founded: {company.profile.foundedYear}</li>}
                {company.profile.publicPrivateStatus && <li>Status: {company.profile.publicPrivateStatus}</li>}
              </ul>
              {company.legalEntities.length > 0 && (
                <ul className="mt-1 space-y-0.5 pl-4 text-ios-text-secondary">
                  {company.legalEntities.map((entity) => (
                    <li key={entity.id}>
                      {entity.legalName} ({entity.jurisdiction}, {entity.registryIdentifier})
                      {entity.registrationStatus && ` — ${entity.registrationStatus}`}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
