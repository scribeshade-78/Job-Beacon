import { useState } from "react";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { approveReviewedAttempt, requestAttemptPreview, type AttemptPreview } from "../lib/attemptReview";

/**
 * The review action for one held attempt.
 *
 * EXTRACTED FROM ApplicationsPanel VERBATIM WHEN THAT PAGE WAS RETIRED, because this
 * component is the reason the page could not simply be deleted: it is the only path in
 * the product to approve a pending_review attempt, and removing it would leave those
 * applications stuck awaiting a review the candidate had no button to give.
 *
 * Shown only for attempts in pending_review, which is the state the review gate holds an
 * application in when candidate_profiles.review_before_submit is true. Nothing here can
 * make an application claimable on its own: the approve call is the candidate's own
 * authenticated request, and the server is what flips the status.
 *
 * TWO STEPS, IN ORDER. The preview must be generated before Approve is even offered,
 * because the approval endpoint refuses an attempt with no prepared resume - approving
 * something the candidate was never shown is exactly what this workflow exists to
 * prevent. Offering the button first and failing on click would be a worse version of the
 * same screen.
 */
export function AttemptReview({ attemptId, onApproved }: { attemptId: string; onApproved: () => void }) {
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
          ? "Rewritten for this role (" + preview.resume.optimizationLevel + "). This exact file is what gets submitted."
          : "Your uploaded resume, unchanged. This exact file is what gets submitted."}
      </p>

      {/* The PDF itself, so approving is a decision about something the candidate has
          actually read. The link above the frame is the fallback for anything that will
          not render a PDF inline. */}
      <a
        href={preview.previewUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 block text-xs text-ios-blue hover:underline"
      >
        Open {preview.resume.originalFilename} in a new tab
      </a>

      <iframe
        title={"Preview of " + preview.resume.originalFilename}
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
          Rendered as preformatted text rather than flowing prose: the paragraphs are
          separated by blank lines and were written as discrete blocks, and a prose
          renderer would re-wrap them into one wall.

          Shown whether or not it exists. A letter that failed its citation gate is stated
          plainly here, next to the resume the candidate IS approving - omitting it would
          let someone approve an application believing it carries a letter it does not
          have. */}
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
