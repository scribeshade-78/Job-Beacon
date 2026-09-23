import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import {
  getCachedInterviewPrep,
  requestInterviewPrep,
  setCachedInterviewPrep,
  type InterviewPrep,
} from "../lib/interviewPrep";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Spinner } from "./ui/spinner";

export interface InterviewPrepDialogProps {
  /** The vacancy to prepare for, or null when the dialog is closed. */
  vacancyId: string | null;
  vacancyTitle: string;
  onClose: () => void;
}

type DialogState =
  | { status: "idle" }
  | { status: "generating" }
  | { status: "ready"; prep: InterviewPrep }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

const STAR_ROWS = [
  ["situation", "Situation"],
  ["task", "Task"],
  ["action", "Action"],
  ["result", "Result"],
] as const;

/**
 * Interview Preparation Phase 2.
 *
 * One generation costs a paid AI call and nothing is persisted server-side, so
 * opening this dialog is the only thing in the product that re-bills for the
 * same result — hence the session cache (see lib/interviewPrep.ts) and an
 * explicit Regenerate rather than a fetch on every open.
 *
 * Rendered in a Dialog rather than inline on the card: the output is long-form
 * (technical + behavioral + STAR + gaps) and would otherwise dominate a
 * already-dense list.
 */
export function InterviewPrepDialog({ vacancyId, vacancyTitle, onClose }: InterviewPrepDialogProps) {
  const [state, setState] = useState<DialogState>({ status: "idle" });

  /**
   * Monotonic request counter. Opening A then quickly closing and opening B
   * leaves A's request in flight; without this, A's response would land after
   * B's and render the wrong vacancy's questions. Every await re-checks that
   * this request is still the newest one.
   */
  const requestSeq = useRef(0);

  async function load(id: string, options: { useCache: boolean }) {
    const seq = (requestSeq.current += 1);

    if (options.useCache) {
      const cached = getCachedInterviewPrep(id);
      if (cached) {
        setState({ status: "ready", prep: cached });
        return;
      }
    }

    setState({ status: "generating" });

    const { data } = await getSupabaseBrowserClient().auth.getSession();
    if (seq !== requestSeq.current) {
      return;
    }

    const accessToken = data.session?.access_token;
    if (!accessToken) {
      setState({ status: "error", message: "Your session has expired. Please sign in again." });
      return;
    }

    const result = await requestInterviewPrep(id, accessToken);
    if (seq !== requestSeq.current) {
      return;
    }

    if (result.kind === "success") {
      setCachedInterviewPrep(id, result.prep);
      setState({ status: "ready", prep: result.prep });
      return;
    }

    setState(
      result.kind === "unavailable"
        ? { status: "unavailable", message: result.message }
        : { status: "error", message: result.message },
    );
  }

  useEffect(() => {
    if (!vacancyId) {
      // Invalidate anything in flight so a late response cannot repopulate a
      // dialog the candidate has already closed.
      requestSeq.current += 1;
      setState({ status: "idle" });
      return;
    }

    void load(vacancyId, { useCache: true });
    // Deliberately keyed on vacancyId only: load() reads the cache and the
    // session itself, so re-running it on every render would defeat the cache
    // and re-bill for each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vacancyId]);

  function renderBody() {
    switch (state.status) {
      case "idle":
      case "generating":
        return (
          <div className="flex items-center gap-3 py-8 text-sm text-ios-text-secondary">
            <Spinner className="h-4 w-4" />
            <span>Generating questions from this job description…</span>
          </div>
        );

      case "unavailable":
        return (
          <div className="py-6">
            <p className="text-sm text-black">{state.message}</p>
            {/* No retry offered: a 4xx is the server declining on the merits,
                so the same request would fail identically. */}
            <div className="mt-5">
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        );

      case "error":
        return (
          <div className="py-6">
            <p className="text-sm text-status-blocked-fg">{state.message}</p>
            <div className="mt-5 flex gap-2">
              <Button onClick={() => vacancyId && void load(vacancyId, { useCache: false })}>Try again</Button>
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        );

      case "ready":
        return renderPrep(state.prep);
    }
  }

  function renderPrep(prep: InterviewPrep) {
    return (
      <div className="mt-4 flex max-h-[62vh] flex-col gap-6 overflow-y-auto pr-1">
        <section>
          <h3 className="text-sm font-semibold text-black">Technical questions</h3>
          <ol className="mt-3 flex flex-col gap-2">
            {prep.technical_questions.map((item) => (
              <li key={item.question} className="rounded-control border border-ios-separator p-3">
                <p className="text-sm font-medium text-black">{item.question}</p>
                <p className="mt-1.5 text-xs text-ios-text-secondary">
                  <span className="font-semibold text-ios-text-secondary">{item.topic}</span>
                  {item.why ? ` — ${item.why}` : ""}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-black">Behavioral questions</h3>
          <ol className="mt-3 flex flex-col gap-2">
            {prep.behavioral_questions.map((item) => (
              <li key={item.question} className="rounded-control border border-ios-separator p-3">
                <p className="text-sm font-medium text-black">{item.question}</p>
                <p className="mt-1.5 text-xs text-ios-text-secondary">
                  <span className="font-semibold text-ios-text-secondary">{item.competency}</span>
                  {item.why ? ` — ${item.why}` : ""}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-black">STAR talking points</h3>

          {prep.star_talking_points.length === 0 ? (
            // The honest empty state. This is not an error and not a loading
            // state: the model is forbidden from inventing experience, so a
            // candidate with nothing confirmed gets no talking points and is
            // told exactly how to unlock them.
            <p className="mt-3 rounded-control border border-ios-separator bg-ios-bg p-3 text-xs text-ios-text-secondary">
              Nothing to suggest yet. STAR talking points are built only from facts you have confirmed, and the model
              is not allowed to invent experience for you. Confirm your facts on the Resumes page and generate again.
            </p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {prep.star_talking_points.map((point) => (
                <article key={point.question} className="rounded-control border border-ios-separator p-3">
                  <p className="text-sm font-medium text-black">{point.question}</p>
                  <dl className="mt-2 flex flex-col gap-1.5">
                    {STAR_ROWS.map(([key, label]) => (
                      <div key={key} className="grid grid-cols-[64px_1fr] gap-2">
                        <dt className="text-xs font-semibold text-ios-text-secondary">{label}</dt>
                        <dd className="text-xs">
                          {point[key] ? (
                            <span className="text-black">{point[key]}</span>
                          ) : (
                            // Explicit, not blank: an empty component means the
                            // confirmed facts did not support it. A blank line
                            // would read as missing data.
                            <span className="text-ios-text-secondary italic">
                              Not supported by your confirmed facts.
                            </span>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </div>
          )}
        </section>

        {prep.gaps.length > 0 && (
          <section>
            <h3 className="text-sm font-semibold text-black">Gaps to prepare for</h3>
            <p className="mt-1 text-xs text-ios-text-secondary">
              This job description asks for these, and none of your confirmed facts cover them.
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {prep.gaps.map((gap) => (
                <li key={gap} className="text-xs text-black">
                  • {gap}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex gap-2 border-t border-ios-separator pt-4">
          <Button
            variant="secondary"
            onClick={() => vacancyId && void load(vacancyId, { useCache: false })}
            disabled={state.status === "generating"}
          >
            Regenerate
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <span className="ml-auto self-center text-xs text-ios-text-secondary">
            Generated for this session only — nothing is saved.
          </span>
        </div>
      </div>
    );
  }

  return (
    <Dialog
      open={vacancyId !== null}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Interview preparation</DialogTitle>
          <DialogDescription>{vacancyTitle}</DialogDescription>
        </DialogHeader>
        {renderBody()}
      </DialogContent>
    </Dialog>
  );
}
