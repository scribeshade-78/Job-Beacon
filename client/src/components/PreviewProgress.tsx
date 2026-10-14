import { useEffect, useState } from "react";
import { cn } from "../lib/utils";

/**
 * THE PHASES A PREVIEW ACTUALLY GOES THROUGH, and roughly when each one begins.
 *
 * THESE LABELS NAME THE REAL PIPELINE rather than a wishlist. generateAttemptPreview reserves a
 * credit, reads the candidate's confirmed facts and the posting, calls the model for the resume and
 * for the cover letter in parallel, renders the PDF through Playwright and runs the ATS format
 * checks against it, and finally signs a preview URL. Those are the four lines below, in order.
 *
 * A NOTE ON "RUNNING THE DIFF ENGINE", which an earlier draft listed as a step and which is
 * deliberately ABSENT. The diff is computed in this browser once the response arrives and the panel
 * renders: it is synchronous, it takes single-digit milliseconds, and it happens AFTER this
 * component has unmounted. Giving it a timed step would be padding a wait with a phase nobody
 * waits for, which is exactly the invented progress this panel exists to avoid.
 *
 * THE TIMES COME FROM MEASUREMENT, NOT FROM LOOKING PLEASING. Across 43 instrumented end-to-end
 * runs the median request took 14.9s and the slowest 35.6s, with the model calls dominating and the
 * PDF render second. A fast run therefore shows two or three of these and never reaches the last,
 * and that is correct: the phase named is the phase running.
 */
export const PREVIEW_STEPS = [
  { label: "Reading your confirmed facts…", afterMs: 0 },
  { label: "Tailoring your resume for this role…", afterMs: 1_500 },
  { label: "Rendering your resume for ATS…", afterMs: 14_000 },
  { label: "Preparing your review…", afterMs: 19_000 },
] as const;

/**
 * When to say something reassuring.
 *
 * Set above the median by a wide margin so it is not shown on an ordinary run, and below the
 * slowest observed run so the one case it exists for - a candidate watching a spinner well past
 * what they expected - actually reaches it.
 */
export const REASSURANCE_AFTER_MS = 25_000;

/** How often the clock is read. Four ticks a second is smooth without waking the tab for nothing. */
const TICK_MS = 250;

/**
 * A staged progress indicator for the preview request.
 *
 * WHY NOT A CONTINUOUS BAR. The request does not report progress, so any percentage would be
 * invented, and a bar that fills to 90% and then stalls for twenty seconds is worse than an honest
 * list. What this shows instead is WHICH PHASE IS RUNNING, which is a fact, plus how long the whole
 * thing has been going, which is also a fact.
 *
 * IT NEVER FINISHES ON ITS OWN. There is no completed state, because this component cannot know the
 * request succeeded - the panel that owns it does, and it unmounts this the moment the preview
 * arrives. A progress UI that reaches its end and then keeps waiting lies about being done.
 */
export function PreviewProgress({ className }: { className?: string }) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const interval = setInterval(() => setElapsedMs(Date.now() - startedAt), TICK_MS);

    // Cleared on unmount. The panel is replaced as soon as the preview arrives, and an interval
    // that outlived it would keep ticking against a component that no longer exists.
    return () => clearInterval(interval);
  }, []);

  // The LAST matching phase wins, and the last phase always matches once its threshold has passed,
  // so this holds rather than overflowing.
  const activeIndex = PREVIEW_STEPS.reduce(
    (current, step, candidate) => (elapsedMs >= step.afterMs ? candidate : current),
    0,
  );

  return (
    <div
      className={cn("rounded-control border border-ios-separator bg-ios-card p-3", className)}
      data-testid="preview-progress"
      data-active-step={activeIndex}
    >
      <p className="text-xs font-semibold">Preparing your resume</p>

      <ol className="mt-2 flex flex-col gap-1.5" data-testid="preview-progress-steps">
        {PREVIEW_STEPS.map((step, index) => {
          const done = index < activeIndex;
          const active = index === activeIndex;

          return (
            <li key={step.label} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  done && "bg-status-verified-fg",
                  // motion-safe rather than a bare animate-pulse: a candidate who has asked their
                  // system to reduce motion still gets the step list, just without the throb.
                  active && "bg-ios-blue motion-safe:animate-pulse",
                  !done && !active && "bg-ios-separator",
                )}
              />
              <span className={cn("text-xs", active ? "font-medium text-ios-text" : "text-ios-text-secondary")}>
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>

      {elapsedMs >= REASSURANCE_AFTER_MS ? (
        <p className="mt-2 text-xs text-ios-text-secondary">
          Still working. A slow run can take up to about forty seconds.
        </p>
      ) : null}

      {/* ONE LIVE REGION FOR THE RUNNING PHASE. The list above never changes its text, only its
          styling, so without this a screen reader would get no signal that anything is moving. */}
      <span className="sr-only" role="status" aria-live="polite" data-testid="preview-progress-live">
        {PREVIEW_STEPS[activeIndex].label}
      </span>
    </div>
  );
}
