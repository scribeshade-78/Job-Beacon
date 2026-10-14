import { useMemo, useState } from "react";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { approveReviewedAttempt, requestAttemptPreview, type AttemptPreview } from "../lib/attemptReview";
import {
  diffResumeWords,
  ResumeDiffTooLargeError,
  summarizeResumeDiff,
  type ResumeDiffSegment,
} from "../lib/resumeDiff";

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
/**
 * The colours for one diff run, and they are TOKEN CLASSES ONLY.
 *
 * --color-status-verified-fg and --color-status-blocked-fg are the TEXT-SAFE members of the
 * status pair. client/src/styles.css documents that the literal hues measure ~2.2:1 to
 * ~3.55:1 against white and cannot carry text under WCAG 2.2 AA, while the -fg variants were
 * computed to clear 4.5:1. The diff is text on a light surface, so it takes the -fg pair.
 *
 * The tinted backgrounds are the LITERAL hues at low alpha, which is what that same comment
 * says they are for: visual distinction on a decorative surface, where WCAG asks for
 * difference rather than a contrast guarantee. A test in AttemptReview.test.tsx fails if any
 * literal colour appears in this file at all.
 */
function diffSegmentClass(kind: ResumeDiffSegment["kind"]): string {
  if (kind === "added") {
    return "bg-status-verified/15 text-status-verified-fg";
  }
  if (kind === "removed") {
    return "bg-status-blocked/15 text-status-blocked-fg line-through";
  }
  return "text-ios-text";
}

/**
 * The headline above the diff.
 *
 * The counts are WORD counts taken from the diff's own runs, not segment counts (which would
 * call "Led a team of six engineers" one change) and not character counts (which say nothing
 * a reader can act on). The second sentence is the honest framing of what the optimizer is
 * allowed to do: it changes how confirmed facts are described, never the facts.
 */
function formatDiffSummary(summary: { addedWords: number; removedWords: number }): string {
  const parts: string[] = [];
  if (summary.addedWords > 0) {
    parts.push(summary.addedWords + " added");
  }
  if (summary.removedWords > 0) {
    parts.push(summary.removedWords + " removed");
  }

  const lead = parts.length > 0 ? parts.join(", ") : "No wording changes";

  return lead + ". Your facts are unchanged — only how they are described.";
}

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

  /**
   * The word diff, derived from the preview rather than stored, so there is nothing to keep
   * in sync. COMPUTED BEFORE THE EARLY RETURN BELOW because hooks cannot run conditionally.
   *
   * IT RETURNS NULL TODAY, AND THAT IS NOT A BUG. The preview endpoint sends a signed PDF URL
   * and four fields of document metadata and no text at all - see the note on
   * AttemptPreview.resume. When the server carries baseText and tailoredText this section
   * appears; until then the panel is exactly what it was, which is more honest than a diff
   * rendered from data we do not have.
   */
  const diff = useMemo(() => {
    const baseText = preview?.resume.baseText;
    const tailoredText = preview?.resume.tailoredText;

    // A half-arrived pair is treated exactly like an absent one: there is no partial diff.
    if (preview?.resume.tailored !== true || !baseText || !tailoredText) {
      return null;
    }

    try {
      const segments = diffResumeWords(baseText, tailoredText);
      return { segments, summary: summarizeResumeDiff(segments) };
    } catch (error) {
      // THE DOCUMENT IS THE THING BEING APPROVED. A wording comparison that cannot be
      // produced must not take the screen down with it - the candidate can still read the
      // PDF and still approve. The engine's size bound is the only expected failure here.
      if (error instanceof ResumeDiffTooLargeError) {
        return null;
      }
      throw error;
    }
  }, [preview]);

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

      {/* WHAT CHANGED, ABOVE THE DOCUMENT. The diff is the digest and the PDF is the detail,
          and someone deciding whether to approve wants the digest first. It is not a
          substitute for the file: the file is what gets sent, and the frame below still shows
          all of it. */}
      {diff ? (
        <div className="mt-3 rounded-control border border-ios-separator bg-ios-card p-3">
          <p className="text-sm font-semibold">What changed</p>
          <p className="mt-0.5 text-xs text-ios-text-secondary">{formatDiffSummary(diff.summary)}</p>

          {/* THE FRAMING, AND IT IS LOAD-BEARING RATHER THAN DECORATIVE.
              A tailored resume is a CONDENSED document built from the candidate's confirmed facts,
              while the base side is their full uploaded resume - so removals outnumber additions
              roughly six to one on a real pair (measured: 269 removed against 45 added words on a
              two-page DOCX). Without this note the panel reads as "we deleted your experience",
              which is both alarming and false: nothing was lost, the document is simply shorter.
              Placed directly above the runs so it is read before they are. */}
          <p
            role="note"
            className="mt-2 rounded-control border border-ios-separator bg-ios-bg px-2.5 py-2 text-xs text-ios-text-secondary"
          >
            Your tailored resume is a highly condensed, ATS-optimized version of your profile. Red text indicates
            information trimmed for maximum impact.
          </p>

          <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">
            {diff.segments.map((segment, index) => (
              <span key={index} className={diffSegmentClass(segment.kind)}>
                {segment.text}
              </span>
            ))}
          </p>
        </div>
      ) : null}

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
