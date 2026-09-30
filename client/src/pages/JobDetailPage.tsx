import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { StatusBadge } from "../components/ui/status-badge";
import {
  FitSection,
  TrustWarnings,
  formatSourceName,
  trustStatusToBadge,
} from "../components/OpportunitySignals";
import { loadJobDetail, type LoadJobDetailResult } from "../lib/jobDetail";
import { formatSalary } from "../lib/opportunities";
import { workplaceLabel } from "../lib/opportunityFilters";
import { describeJobLink, describeJobLinkAriaLabel } from "../lib/jobLink";
import { safeVacancyHref } from "../panels/shared";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

interface JobDetailPageProps {
  jobId: string;
}

type JobDetailState = { kind: "loading" } | LoadJobDetailResult;

/**
 * One listing read inside JobBeacon, before the candidate decides to leave.
 *
 * WHY THIS EXISTS. The job title was an outbound link, so the only way to learn
 * anything beyond the card was to open the job board. This page shows the same
 * listing in full — description, salary, work mode, source and the trust /
 * eligibility signals the card carries — and keeps the outbound link as an
 * explicit, labelled action rather than the default one.
 *
 * THE DATA IS THE EXISTING DATA SOURCE. The summary comes from the same
 * candidate_opportunities read the panel uses (lib/jobDetail.ts ->
 * listOpportunitiesByIds), and the description from vacancy_jd_snapshots, the
 * table the fit worker already writes. No new schema, table or endpoint.
 *
 * THE ROUTE IS NOT A SECURITY BOUNDARY. The view is RLS-scoped to the caller
 * through security_invoker, and the JD snapshot is public employer-posting
 * text (grant select to authenticated, 20260831120000).
 */
export function JobDetailPage({ jobId }: JobDetailPageProps) {
  const [state, setState] = useState<JobDetailState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    loadJobDetail(getSupabaseBrowserClient(), jobId).then((result) => {
      if (!cancelled) {
        setState(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (state.kind === "loading") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Job details</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ios-text-secondary animate-pulse">Loading job details…</p>
        </CardContent>
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Job details</CardTitle>
        </CardHeader>
        <CardContent>
          <p role="alert" className="text-sm text-status-blocked-fg">
            {state.message}
          </p>
          <Link href="/opportunities" className="mt-3 inline-block text-sm text-ios-blue hover:underline">
            ← Back to opportunities
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (state.kind === "not_found") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Job not found</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ios-text-secondary">
            This listing is no longer available, or it is not one of the verified active postings.
          </p>
          <Link href="/opportunities" className="mt-3 inline-block text-sm text-ios-blue hover:underline">
            ← Back to opportunities
          </Link>
        </CardContent>
      </Card>
    );
  }

  const { job, description } = state;
  const workMode = workplaceLabel(job.remoteType);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{job.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-ios-text-secondary">
          {job.companyName && <span className="font-medium text-black">{job.companyName}</span>}
          {job.companyDomain && <span>· {job.companyDomain}</span>}
          <span>· {job.location}</span>
          {workMode && <span className="rounded bg-ios-separator px-2 py-0.5 text-xs">{workMode}</span>}
          <span className="text-xs">· via {formatSourceName(job.sourceCode)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={trustStatusToBadge(job.trustStatus)} />
          <span className="text-xs text-ios-text-secondary">{formatSalary(job.salary)}</span>
        </div>

        <TrustWarnings trustStatus={job.trustStatus} />

        <FitSection fit={job.fitAnalysis} />

        <section>
          <h2 className="text-sm font-semibold text-black">Job description</h2>
          {description === null ? (
            <p className="mt-2 text-sm text-ios-text-secondary">
              We do not have a captured description for this listing. Open the original posting on{" "}
              {formatSourceName(job.sourceCode)} to read it.
            </p>
          ) : (
            <div className="mt-2 whitespace-pre-wrap text-sm text-black">{description.cleanText}</div>
          )}
        </section>

        <div className="flex flex-wrap items-center gap-3">
          {/* THE OUTBOUND LINK, LABELLED HONESTLY. Same describeJobLink rule as
              the card used: "apply" only where the URL is the employer's own
              hosted application form, "open" for a source's own page. */}
          <a
            href={safeVacancyHref(job.url)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={describeJobLinkAriaLabel(job.sourceCode, job.title)}
            className="rounded-control border border-ios-separator px-3 py-1.5 text-sm font-medium text-ios-blue hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue"
          >
            {describeJobLink(job.sourceCode).label}
          </a>
          <Link href="/opportunities" className="text-sm text-ios-blue hover:underline">
            ← Back to opportunities
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
