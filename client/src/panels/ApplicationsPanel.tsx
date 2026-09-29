import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { ATTEMPT_STATUS_LABELS, listApplications, type ApplicationSummary } from "../lib/applications";
import {
  approveReviewedAttempt,
  requestAttemptPreview,
  type AttemptPreview,
} from "../lib/attemptReview";
import {
  countByPipelineStage,
  filterByPipelineStage,
  PIPELINE_STAGES,
  type PipelineStageId,
} from "../lib/pipelineStages";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { safeVacancyHref } from "./shared";
import { cn } from "../lib/utils";

/**
 * The review action for one held attempt.
 *
 * Shown only for attempts in pending_review, which is the state the review
 * gate holds an application in when candidate_profiles.review_before_submit is
 * true. Nothing here can make an application claimable on its own: the approve
 * call is the candidate's own authenticated request, and the server is what
 * flips the status.
 *
 * TWO STEPS, IN ORDER. The preview must be generated before Approve is even
 * offered, because the approval endpoint refuses an attempt with no prepared
 * resume — approving something the candidate was never shown is exactly what
 * this workflow exists to prevent. Offering the button first and failing on
 * click would be a worse version of the same screen.
 */
function AttemptReview({ attemptId, onApproved }: { attemptId: string; onApproved: () => void }) {
  const [preview, setPreview] = useState<AttemptPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePreview() {
    setLoading(true);
    setError(null);

    const result = await requestAttemptPreview(attemptId);

    setLoading(false);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    setPreview(result.preview);
  }

  async function handleApprove() {
    setApproving(true);
    setError(null);

    const result = await approveReviewedAttempt(attemptId);

    setApproving(false);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    onApproved();
  }

  if (!preview) {
    return (
      <div className="mt-2">
        <Button size="sm" onClick={handlePreview} disabled={loading}>
          {loading ? <Spinner className="h-4 w-4" /> : null}
          {loading ? "Preparing your resume…" : "Review & Approve"}
        </Button>
        {error && (
          <p role="alert" className="mt-1 text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-card border border-ios-separator bg-ios-bg p-3">
      <p className="text-sm font-semibold">Your tailored resume</p>
      <p className="mt-0.5 text-xs text-ios-text-secondary">
        {preview.resume.tailored
          ? `Rewritten for this role (${preview.resume.optimizationLevel}). This exact file is what gets submitted.`
          : "Your uploaded resume, unchanged. This exact file is what gets submitted."}
      </p>

      {/* The PDF itself, so approving is a decision about something the
          candidate has actually read. The link above the frame is the fallback
          for anything that will not render a PDF inline. */}
      <a
        href={preview.previewUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 block text-xs text-ios-blue hover:underline"
      >
        Open {preview.resume.originalFilename} in a new tab
      </a>

      <iframe
        title={`Preview of ${preview.resume.originalFilename}`}
        src={preview.previewUrl}
        className="mt-2 h-96 w-full rounded-control border border-ios-separator bg-white"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={handleApprove} disabled={approving}>
          {approving ? <Spinner className="h-4 w-4" /> : null}
          {approving ? "Approving…" : "Approve for Submission"}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setPreview(null)} disabled={approving}>
          Not now
        </Button>
      </div>

      {/* The cover letter, above the controls that approve it.
          Rendered as preformatted text rather than flowing prose: the
          paragraphs are separated by blank lines and were written as discrete
          blocks, and a prose renderer would re-wrap them into one wall.

          Shown whether or not it exists. A letter that failed its citation
          gate is stated plainly here, next to the resume the candidate IS
          approving — omitting it would let someone approve an application
          believing it carries a letter it does not have. */}
      <div className="mt-3 border-t border-ios-separator pt-3">
        <p className="text-sm font-semibold">Cover letter</p>

        {preview.coverLetter.status === "generated" ? (
          <>
            <p className="mt-0.5 text-xs text-ios-text-secondary">
              Written from {preview.coverLetter.citedFactCount}{" "}
              {preview.coverLetter.citedFactCount === 1 ? "fact" : "facts"} you confirmed. This exact text is
              what gets sent.
            </p>
            <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-control border border-ios-separator bg-ios-card p-3 text-sm leading-relaxed text-black">
              {preview.coverLetter.text}
            </div>
          </>
        ) : (
          <p
            role="note"
            className="mt-1 rounded border border-status-under-review/40 bg-status-under-review/8 px-3 py-2 text-xs text-status-under-review-fg"
          >
            <span className="font-semibold">No cover letter for this application.</span> {preview.coverLetter.reason}
          </p>
        )}
      </div>

      <p className="mt-2 text-xs text-ios-text-secondary">
        Nothing is sent until you approve. The link expires in{" "}
        {Math.round(preview.previewUrlExpiresInSeconds / 60)} minutes.
      </p>

      {error && (
        <p role="alert" className="mt-2 text-sm text-status-blocked-fg">
          {error}
        </p>
      )}
    </div>
  );
}

export function ApplicationsPanel() {
  const [applications, setApplications] = useState<ApplicationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<PipelineStageId>("all");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    listApplications(getSupabaseBrowserClient()).then((result) => {
      if (cancelled) return;

      if (result.kind === "success") {
        setApplications(result.applications);
        setError(null);
      } else {
        setError(result.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const counts = useMemo(() => countByPipelineStage(applications ?? []), [applications]);
  const visibleApplications = useMemo(
    () => filterByPipelineStage(applications ?? [], stage),
    [applications, stage],
  );

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

        {/* Stage bar. Same segmented treatment as AuthCard's switcher, but
            flex + overflow-x-auto rather than a fixed grid: five labels with
            counts do not fit a phone, and scrolling beats wrapping or
            truncating a stage name. */}
        <div
          role="tablist"
          aria-label="Application pipeline stage"
          className="mb-4 flex gap-1 overflow-x-auto rounded-control bg-ios-bg p-1"
        >
          {PIPELINE_STAGES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`pipeline-tab-${id}`}
              aria-selected={stage === id}
              aria-controls="applications-panel"
              onClick={() => setStage(id)}
              className={cn(
                "h-9 shrink-0 whitespace-nowrap rounded-[8px] px-3 text-sm font-semibold transition-colors",
                stage === id ? "bg-ios-card text-black shadow-control" : "text-ios-text-secondary hover:text-black",
              )}
            >
              {label}
              <span className="ml-1.5 text-xs font-normal opacity-70">{counts[id]}</span>
            </button>
          ))}
        </div>

        <div role="tabpanel" id="applications-panel" aria-labelledby={`pipeline-tab-${stage}`}>
          {applications?.length === 0 && <p className="text-sm text-ios-text-secondary">No applications yet.</p>}

          {/* Distinct from the state above: "none at all" and "none in this
              stage" are different facts, and the second must not read as an
              empty account. */}
          {applications !== null && applications.length > 0 && visibleApplications.length === 0 && (
            <p className="text-sm text-ios-text-secondary">
              No applications in {PIPELINE_STAGES.find((entry) => entry.id === stage)?.label.toLowerCase()} yet.
            </p>
          )}

          <ul className="space-y-3">
            {visibleApplications.map((application) => (
              <li key={application.planId} className="border-b border-ios-separator pb-3 last:border-0 last:pb-0">
                <a
                  href={safeVacancyHref(application.vacancyUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-ios-blue hover:underline"
                >
                  {application.vacancyTitle}
                </a>
                {application.companyName && (
                  <span className="text-sm text-ios-text-secondary"> · {application.companyName}</span>
                )}{" "}
                <span className="text-sm text-ios-text-secondary">
                  — {application.eligible ? "eligible" : "not eligible"}
                </span>

                {/* Surfaced so a row's stage membership is inspectable rather
                    than something the filter asserts invisibly. These are the
                    raw categories, including ones with no chip in the bar. */}
                {application.responseCategories.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-ios-text-secondary">Responses:</span>
                    {application.responseCategories.map((category) => (
                      <span key={category} className="rounded bg-ios-separator px-2 py-0.5 text-xs text-black">
                        {category.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                )}

                {application.attempts.length > 0 && (
                  <ul className="mt-1 space-y-1.5 pl-4 text-sm text-ios-text-secondary">
                    {application.attempts.map((attempt) => (
                      <li key={attempt.id}>
                        {/* The label, with the raw status kept alongside it:
                            the label is what the candidate reads, and the
                            token is what they would quote when reporting a
                            problem. */}
                        <span title={attempt.status}>
                          {ATTEMPT_STATUS_LABELS[attempt.status] ?? attempt.status}
                        </span>
                        {attempt.lastError && `: ${attempt.lastError}`}

                        {/* WHAT ACTUALLY HAPPENED, where it happened. Only ever
                            rendered from recorded evidence, so a status label can
                            never be the sole claim that something was submitted.
                            Everything here was whitelisted by
                            applicationEvidence.ts — no raw payload reaches this
                            point. */}
                        {attempt.evidence.length > 0 && (
                          <ul className="mt-1 space-y-1" aria-label="Submission evidence">
                            {attempt.evidence.map((evidence) => (
                              <li
                                key={evidence.id}
                                className="rounded border border-ios-separator bg-ios-bg px-2.5 py-1.5"
                              >
                                <span className="font-medium text-black">{evidence.title}</span>
                                {evidence.details.map((detail) => (
                                  <span key={detail} className="mt-0.5 block text-xs">
                                    {detail}
                                  </span>
                                ))}
                                <span className="mt-0.5 block text-xs opacity-70">
                                  {formatDistanceToNow(new Date(evidence.capturedAt), {
                                    addSuffix: true,
                                  })}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}

                        {attempt.status === "pending_review" && (
                          <AttemptReview
                            attemptId={attempt.id}
                            onApproved={() => setReloadToken((token) => token + 1)}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
