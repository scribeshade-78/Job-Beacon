import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button, buttonVariants } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import {
  listActionRequiredEvents,
  type ActionRequiredEvent,
  type ActionRequiredExceptionType,
} from "../lib/actionRequired";
import {
  describeWait,
  dismissFollowUp,
  listPendingFollowUps,
  sendFollowUp,
  type PendingFollowUp,
} from "../lib/followUps";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { safeVacancyHref } from "./shared";

const ACTION_REQUIRED_LABELS: Record<ActionRequiredExceptionType, string> = {
  captcha: "CAPTCHA to solve",
  otp_or_email_code: "One-time code needed",
  unknown_sensitive_question: "Unrecognized or sensitive question",
  missing_verified_fact: "Missing verified information",
  external_assessment: "External assessment or interview",
  unsupported_portal: "Unsupported application portal",
  payment_or_financial_request: "Payment or financial information requested",
};

/**
 * Follow-ups the anti-ghosting sweep has drafted and the candidate has not yet
 * ruled on.
 *
 * WHAT THIS SCREEN IS FOR. An application that has gone quiet for a week gets a
 * polite nudge, and the candidate decides whether it goes out. Nothing is sent
 * automatically and nothing is sent by clicking anything else — this list is the
 * only place a follow-up can leave.
 *
 * THE "SEND" BUTTON DOES NOT SEND AN EMAIL YET, and the UI says so rather than
 * implying otherwise. There is no SMTP client, no outbound mailbox, and no
 * recipient address anywhere in the schema — an employer's address is never
 * stored, and the only addresses this database has seen are ones employers
 * wrote FROM. Approving records the candidate's decision and logs the letter;
 * delivery is a later phase. A candidate told "Sent" here would be told
 * something untrue, and would reasonably expect a reply that could never come.
 *
 * LAYOUT: this panel appears both full-width (the Action Required page) and in
 * a narrow dashboard column (OverviewPage's lg:col-span-4). Everything below
 * stacks by default and only goes horizontal when there is room, so the same
 * markup survives both.
 */
function FollowUpReview() {
  const [followUps, setFollowUps] = useState<PendingFollowUp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    listPendingFollowUps().then((result) => {
      if (cancelled) return;

      if (result.kind === "success") {
        setFollowUps(result.followUps);
      } else {
        setError(result.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSend(draftId: string) {
    setBusyId(draftId);
    setError(null);
    setNotice(null);

    const result = await sendFollowUp(draftId);

    setBusyId(null);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    // The server's own wording, which states plainly that nothing was
    // transmitted. Not paraphrased here: the one place this must not drift is
    // between what happened and what the candidate is told happened.
    if ("note" in result) {
      setNotice(result.note);
    }

    setFollowUps((previous) => (previous ?? []).filter((entry) => entry.draftId !== draftId));
  }

  async function handleDismiss(draftId: string) {
    setBusyId(draftId);
    setError(null);
    setNotice(null);

    const result = await dismissFollowUp(draftId);

    setBusyId(null);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    setFollowUps((previous) => (previous ?? []).filter((entry) => entry.draftId !== draftId));
  }

  // Nothing to say until the list has loaded, so the empty state is not
  // rendered and then contradicted a moment later.
  if (followUps === null && !error) {
    return null;
  }

  const hasFollowUps = (followUps?.length ?? 0) > 0;

  if (!hasFollowUps && !error && !notice) {
    return null;
  }

  return (
    <section aria-labelledby="follow-ups-title" className="mb-6">
      <h3 id="follow-ups-title" className="text-base font-semibold text-black">
        Follow-ups to review
        {hasFollowUps && <span className="ml-1.5 text-sm font-normal text-ios-text-secondary">{followUps?.length}</span>}
      </h3>
      <p className="mt-0.5 text-xs text-ios-text-secondary">
        These applications have had no reply for a week or more. Nothing is sent until you approve it.
      </p>

      {error && (
        <p role="alert" className="mt-2 text-sm text-status-blocked-fg">
          {error}
        </p>
      )}

      {notice && (
        <p
          role="status"
          className="mt-2 rounded border border-status-under-review/40 bg-status-under-review/8 px-3 py-2 text-xs text-status-under-review-fg"
        >
          {notice}
        </p>
      )}

      <ul className="mt-3 space-y-3">
        {followUps?.map((followUp) => (
          <li key={followUp.draftId} className="rounded-control border border-ios-separator p-4">
            <div className="flex flex-wrap items-baseline gap-x-2">
              {followUp.companyName && <p className="font-medium text-black">{followUp.companyName}</p>}
              <p className={followUp.companyName ? "text-sm text-ios-text-secondary" : "font-medium text-black"}>
                {followUp.vacancyTitle}
              </p>
            </div>

            <p className="mt-0.5 text-xs text-ios-text-secondary">
              {/* Both, deliberately: the day count is the fact, the phrase is
                  how a person says it, and a candidate deciding whether to
                  nudge an employer wants the exact number. */}
              Applied {followUp.daysSinceSubmission} {followUp.daysSinceSubmission === 1 ? "day" : "days"} ago ·{" "}
              {describeWait(followUp.daysSinceSubmission)}
            </p>

            {/* The exact text, not a summary of it. The candidate is approving
                these words going to an employer in their name. */}
            <div className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-control border border-ios-separator bg-ios-bg p-3 text-sm leading-relaxed text-black">
              {followUp.draftText}
            </div>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button size="sm" onClick={() => void handleSend(followUp.draftId)} disabled={busyId === followUp.draftId}>
                {busyId === followUp.draftId ? <Spinner className="h-4 w-4" /> : null}
                Approve &amp; Send
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void handleDismiss(followUp.draftId)}
                disabled={busyId === followUp.draftId}
              >
                Dismiss
              </Button>
              {followUp.vacancyUrl && (
                <a
                  href={safeVacancyHref(followUp.vacancyUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-ios-blue hover:underline sm:ml-auto"
                >
                  Open posting
                </a>
              )}
            </div>

            <p className="mt-2 text-[11px] text-ios-text-secondary">
              Drafted by {followUp.modelVersion} · prompt {followUp.promptVersion}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ActionRequiredPanel() {
  const [events, setEvents] = useState<ActionRequiredEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listActionRequiredEvents(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setEvents(result.events);
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle id="action-required-title">Action Required</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="action-required-title">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}

        <FollowUpReview />

        {events?.length === 0 && (
          <p className="text-sm text-ios-text-secondary">Nothing needs your attention right now.</p>
        )}
        <ul className="space-y-3">
          {events?.map((event) => (
            <li
              key={event.id}
              className="flex flex-col gap-2 rounded-control border border-ios-separator p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="font-medium text-black">{event.vacancyTitle}</p>
                <p className="text-sm text-ios-text-secondary">
                  {ACTION_REQUIRED_LABELS[event.exceptionType]}
                  {event.expiresAt && ` (expires ${event.expiresAt})`}
                </p>
              </div>
              <a
                href={safeVacancyHref(event.vacancyUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants("primary", "sm")}
              >
                View details
              </a>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
