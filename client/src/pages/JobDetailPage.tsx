import { useEffect, useState } from "react";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { StatusBadge } from "../components/ui/status-badge";
import {
  FitSection,
  TrustWarnings,
  formatSourceName,
  trustStatusToBadge,
} from "../components/OpportunitySignals";
import {
  loadJobDetail,
  type CompanyContext,
  type JobDescription,
  type LoadJobDetailResult,
} from "../lib/jobDetail";
import { formatSalary } from "../lib/opportunities";
import { workplaceLabel } from "../lib/opportunityFilters";
import { describeJobLink, describeJobLinkAriaLabel } from "../lib/jobLink";
import { safeVacancyHref } from "../panels/shared";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { describeBulkApplyResult, submitBulkApply } from "../lib/bulkApply";
import {
  REPORT_CATEGORIES,
  REPORT_CATEGORY_LABELS,
  isReportCategory,
  submitVacancyReport,
  type ReportCategory,
} from "../lib/vacancyReports";

interface JobDetailPageProps {
  jobId: string;
  /**
   * Optional because SignedInRoutes types it `string | undefined` (the id is
   * absent until the session resolves). Reporting needs it, so an absent id is
   * refused with a session message rather than an insert that RLS would reject.
   */
  candidateId?: string;
}

type JobDetailState = { kind: "loading" } | LoadJobDetailResult;

/**
 * The one phrase every absent field uses.
 *
 * A single constant rather than a repeated literal so the page cannot end up
 * saying "Not provided by source", "Unknown" and "—" for the same fact. It is
 * deliberately NOT "None" or "N/A": the honest claim is that the SOURCE did not
 * publish it, which is different from the job not having it.
 */
export const NOT_PROVIDED_BY_SOURCE = "Not provided by source";

function NotProvided() {
  return <span className="text-sm italic text-ios-text-secondary">{NOT_PROVIDED_BY_SOURCE}</span>;
}

/** One labelled row of the company context block. */
function ContextRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <dt className="text-ios-text-secondary">{label}</dt>
      <dd className="text-black">{value === null ? <NotProvided /> : value}</dd>
    </div>
  );
}

function CompanyContextSection({ company }: { company: CompanyContext | null }) {
  if (company === null) {
    return (
      <p className="mt-2 text-sm text-ios-text-secondary">
        We have no verified company facts for this listing yet.
      </p>
    );
  }

  return (
    <dl className="mt-2 space-y-1">
      <ContextRow label="Industry" value={company.industry} />
      <ContextRow label="Headquarters" value={company.headquartersCountry} />
      <ContextRow
        label="Operates in"
        value={company.operatingCountries.length > 0 ? company.operatingCountries.join(", ") : null}
      />
      <ContextRow label="Company size" value={company.employeeSizeRange} />
      <ContextRow label="Founded" value={company.foundedYear === null ? null : String(company.foundedYear)} />
      <ContextRow label="Public or private" value={company.publicPrivateStatus} />
    </dl>
  );
}

/**
 * The captured job description.
 *
 * PREFERS THE DETECTED SECTIONS over clean_text when the extractor found
 * headings: responsibilities, requirements and skills are then readable as
 * sections instead of one wall of text. clean_text remains the fallback for the
 * no-heading majority, and an absent snapshot says so in the same words every
 * other missing field uses.
 */
function JobDescriptionSection({ description }: { description: JobDescription | null }) {
  if (description === null) {
    return (
      <p className="mt-2 text-sm text-ios-text-secondary">
        We do not have a captured description for this listing.{" "}
        <NotProvided />
      </p>
    );
  }

  if (description.sections.length > 0) {
    return (
      <div className="mt-2 space-y-4">
        {description.sections.map((section, index) => (
          <div key={(section.heading ?? "section") + "-" + index}>
            {section.heading !== null && (
              <h3 className="text-sm font-semibold text-black">{section.heading}</h3>
            )}
            {section.body.trim() !== "" && (
              <p className="mt-1 whitespace-pre-wrap text-sm text-black">{section.body}</p>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (description.cleanText.trim() !== "") {
    return <p className="mt-2 whitespace-pre-wrap text-sm text-black">{description.cleanText}</p>;
  }

  return (
    <p className="mt-2 text-sm text-ios-text-secondary">
      We do not have a captured description for this listing. <NotProvided />
    </p>
  );
}

export function JobDetailPage({ jobId, candidateId }: JobDetailPageProps) {
  const [state, setState] = useState<JobDetailState>({ kind: "loading" });

  // Queue outcome, rendered beside the button that produced it. Kept as one
  // string so a success and a refusal share the same slot: a candidate who
  // clicked once should not have to hunt for which of two regions changed.
  const [queueMessage, setQueueMessage] = useState<string | null>(null);
  const [queuePending, setQueuePending] = useState(false);

  const [reportOpen, setReportOpen] = useState(false);
  const [reportCategory, setReportCategory] = useState<ReportCategory>("fake_job");
  const [reportDescription, setReportDescription] = useState("");
  const [reportStatus, setReportStatus] = useState<
    { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string }
  >({ kind: "idle" });

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

  const { job, description, company } = state;
  const workMode = workplaceLabel(job.remoteType);
  const hasLocation = job.city !== null || job.country !== null;

  async function handleQueue() {
    setQueuePending(true);
    setQueueMessage(null);

    const result = await submitBulkApply([job.id]);
    setQueuePending(false);

    if (result.kind === "error") {
      setQueueMessage(result.message);
      return;
    }

    setQueueMessage(describeBulkApplyResult(result.result).text);
  }

  async function handleReport() {
    if (candidateId === undefined) {
      setReportStatus({ kind: "error", message: "Your session has expired. Please sign in again." });
      return;
    }

    setReportStatus({ kind: "sending" });

    const result = await submitVacancyReport(
      getSupabaseBrowserClient(),
      candidateId,
      job.id,
      reportCategory,
      reportDescription,
    );

    if (result.kind === "error") {
      setReportStatus({ kind: "error", message: result.message });
      return;
    }

    setReportStatus({ kind: "sent" });
    setReportDescription("");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{job.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center gap-2 text-sm text-ios-text-secondary">
          {job.companyName !== null ? (
            <span className="font-medium text-black">{job.companyName}</span>
          ) : (
            <NotProvided />
          )}
          {job.companyDomain !== null && <span>· {job.companyDomain}</span>}
          <span>· {hasLocation ? job.location : <NotProvided />}</span>
          {workMode && <span className="rounded bg-ios-separator px-2 py-0.5 text-xs">{workMode}</span>}
          <span className="text-xs">· via {formatSourceName(job.sourceCode)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={trustStatusToBadge(job.trustStatus)} />
          <span className="text-xs text-ios-text-secondary">
            {job.salary.min === null && job.salary.max === null ? (
              <NotProvided />
            ) : (
              formatSalary(job.salary)
            )}
          </span>
        </div>

        {/* Freshness. Two different facts, so two phrases: "when we first saw
            it" and "when we last confirmed it still exists". */}
        <p className="text-xs text-ios-text-secondary">
          Discovered {formatDistanceToNow(new Date(job.discoveredAt), { addSuffix: true })} · Last
          confirmed {formatDistanceToNow(new Date(job.lastSeenAt), { addSuffix: true })}
        </p>

        <TrustWarnings trustStatus={job.trustStatus} />

        <section aria-label="Match and eligibility">
          <h2 className="text-sm font-semibold text-black">Match and eligibility</h2>
          <FitSection fit={job.fitAnalysis} variant="detail" />
        </section>

        <section aria-label="Job description">
          <h2 className="text-sm font-semibold text-black">Job description</h2>
          {description?.capturedAt != null && (
            <p className="text-xs text-ios-text-secondary">
              Captured {formatDistanceToNow(new Date(description.capturedAt), { addSuffix: true })}
            </p>
          )}
          <JobDescriptionSection description={description} />
        </section>

        <section aria-label="Company context">
          <h2 className="text-sm font-semibold text-black">Company context</h2>
          <CompanyContextSection company={company} />
        </section>

        {/* ACTIONS. The outbound link is deliberately the last, separate item
            rather than the default: reading the listing inside JobBeacon is the
            primary path, and leaving the site is a decision the candidate makes
            after reading. */}
        <section aria-label="Actions" className="space-y-3 border-t border-ios-separator pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={() => void handleQueue()} disabled={queuePending}>
              {queuePending ? "Adding…" : "Add to review queue"}
            </Button>

            <a
              href={safeVacancyHref(job.url)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={describeJobLinkAriaLabel(job.sourceCode, job.title)}
              className="rounded-control border border-ios-separator px-3 py-1.5 text-sm font-medium text-ios-blue hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue"
            >
              {describeJobLink(job.sourceCode).label}
            </a>

            <button
              type="button"
              onClick={() => {
                setReportOpen((open) => !open);
                setReportStatus({ kind: "idle" });
              }}
              aria-expanded={reportOpen}
              className="text-sm text-ios-blue hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue"
            >
              Report this listing
            </button>

            <Link href="/opportunities" className="text-sm text-ios-blue hover:underline">
              ← Back to opportunities
            </Link>
          </div>

          {queueMessage !== null && (
            <p role="status" className="text-sm text-ios-text-secondary">
              {queueMessage}
            </p>
          )}

          {reportOpen && (
            <form
              aria-label="Report this listing"
              className="space-y-3 rounded-control border border-ios-separator p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void handleReport();
              }}
            >
              <div>
                <label className="block text-sm font-medium text-black" htmlFor="report-category">
                  What is wrong with this listing?
                </label>
                <select
                  id="report-category"
                  value={reportCategory}
                  onChange={(event) => {
                    const value: unknown = event.target.value;
                    if (isReportCategory(value)) {
                      setReportCategory(value);
                    }
                  }}
                  className="mt-1 w-full rounded-control border border-ios-separator bg-white px-2 py-1.5 text-sm"
                >
                  {REPORT_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {REPORT_CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-black" htmlFor="report-description">
                  Anything else we should know? (optional)
                </label>
                <textarea
                  id="report-description"
                  value={reportDescription}
                  onChange={(event) => setReportDescription(event.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-control border border-ios-separator bg-white px-2 py-1.5 text-sm"
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="secondary" disabled={reportStatus.kind === "sending"}>
                  {reportStatus.kind === "sending" ? "Sending…" : "Send report"}
                </Button>

                {reportStatus.kind === "sent" && (
                  <p role="status" className="text-sm text-ios-text-secondary">
                    Thanks — your report has been recorded.
                  </p>
                )}
                {reportStatus.kind === "error" && (
                  <p role="alert" className="text-sm text-status-blocked-fg">
                    {reportStatus.message}
                  </p>
                )}
              </div>
            </form>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
