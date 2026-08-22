import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { listApplications, type ApplicationSummary } from "../lib/applications";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { safeVacancyHref } from "./shared";

export function ApplicationsPanel() {
  const [applications, setApplications] = useState<ApplicationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listApplications(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setApplications(result.applications);
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle id="applications-title">Applications</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="applications-title">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        {applications?.length === 0 && <p className="text-sm text-ios-text-secondary">No applications yet.</p>}
        <ul className="space-y-3">
          {applications?.map((application) => (
            <li key={application.planId} className="border-b border-ios-separator pb-3 last:border-0 last:pb-0">
              <a
                href={safeVacancyHref(application.vacancyUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-ios-blue hover:underline"
              >
                {application.vacancyTitle}
              </a>{" "}
              <span className="text-sm text-ios-text-secondary">
                — {application.eligible ? "eligible" : "not eligible"}
              </span>
              {application.attempts.length > 0 && (
                <ul className="mt-1 space-y-0.5 pl-4 text-sm text-ios-text-secondary">
                  {application.attempts.map((attempt) => (
                    <li key={attempt.id}>
                      {attempt.status}
                      {attempt.lastError && `: ${attempt.lastError}`}
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
