import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { ATTEMPT_STATUS_LABELS, listApplications, type ApplicationSummary } from "../lib/applications";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { AttemptReview } from "../panels/AttemptReview";
import { appendAttemptId, safeVacancyHref } from "../panels/shared";
import { cn } from "../lib/utils";
import type { ResponseCategory } from "../../../shared/priorityScore";

/**
 * The application tracker: what the candidate has sent, and what came back.
 *
 * REAL DATA, FROM THE SAME SOURCE THE OLD APPLICATIONS PANEL USED - listApplications.
 * There is no mock and no sample-data banner any more.
 *
 * THERE IS NO EMAIL BODY IN THIS DATA, AND THE PANE DOES NOT PRETEND OTHERWISE. The
 * scaffolded version showed invented messages; ApplicationSummary exposes no subject or
 * body, only the attempt lifecycle, the recorded evidence and the classified response
 * categories. Full messages live in the Inbox, which reads a different table. Showing
 * what this source actually holds is the honest option; fetching bodies from a second
 * source here would duplicate the Inbox and blur what each page is for.
 *
 * THE STAGE IS DERIVED, NOT INVENTED. An employer's response stage comes from
 * responseCategories (a classified reply, highest stage wins); with no reply, a
 * successful submission is "Applied". The lifecycle status alone cannot tell you an
 * interview happened - only a classified message can.
 */

export type TrackerStage =
  | "applied"
  | "interview"
  | "offer"
  | "rejection"
  | "in_progress"
  | "archived"
  /**
   * THE HONEST NAME FOR A STUCK APPLICATION.
   *
   * An attempt sits in 'submitting' when we believe it was sent but hold no receipt - the
   * extension reported success with nothing that proves it. Left as it was, that rendered
   * as "In progress", which reads as "working on it" when the truth is "we do not know,
   * and you should check". It is the one status where the candidate can still act, so it
   * gets the loudest label.
   */
  | "needs_verification";

const STAGE: Record<TrackerStage, { label: string; badge: string; dot: string }> = {
  applied: {
    label: "Applied",
    badge: "border-ios-blue/30 bg-ios-blue/10 text-ios-blue",
    dot: "bg-ios-blue",
  },
  interview: {
    label: "Interview",
    badge: "border-status-under-review/40 bg-status-under-review/10 text-status-under-review-fg",
    dot: "bg-status-under-review",
  },
  offer: {
    label: "Offer",
    badge: "border-status-verified/40 bg-status-verified/10 text-status-verified-fg",
    dot: "bg-status-verified",
  },
  rejection: {
    label: "Rejection",
    badge: "border-status-blocked/40 bg-status-blocked/10 text-status-blocked-fg",
    dot: "bg-status-blocked",
  },
  in_progress: {
    label: "In progress",
    badge: "border-ios-separator bg-ios-bg text-ios-text-secondary",
    dot: "bg-status-action-required",
  },
  archived: {
    label: "Archived",
    badge: "border-ios-separator bg-ios-bg text-ios-text-secondary",
    dot: "bg-ios-separator",
  },
  needs_verification: {
    label: "Action Required",
    badge: "border-status-blocked/40 bg-status-blocked/10 text-status-blocked-fg",
    dot: "bg-status-blocked",
  },
};

const FILTERS: Array<{ id: "all" | TrackerStage; label: string }> = [
  { id: "all", label: "All" },
  { id: "applied", label: "Applied" },
  { id: "interview", label: "Interview" },
  { id: "offer", label: "Offer" },
  { id: "rejection", label: "Rejection" },
  { id: "in_progress", label: "In progress" },
  { id: "needs_verification", label: "Action Required" },
  { id: "archived", label: "Archived" },
];

/** Highest stage wins, mirroring RESPONSE_STAGE_VALUE's ordering in shared/priorityScore. */
const CATEGORY_ORDER: ResponseCategory[] = [
  "offer",
  "interview",
  "action_required",
  "recruiter_followup",
  "application_received",
  "other",
  "rejection",
];

export function stageOf(application: ApplicationSummary): TrackerStage {
  const categories = application.responseCategories ?? [];

  for (const category of CATEGORY_ORDER) {
    if (!categories.includes(category)) continue;
    if (category === "offer") return "offer";
    if (category === "interview") return "interview";
    if (category === "rejection") return "rejection";
    // A real reply that is not a stage signal: the application is live, not rejected.
    return "applied";
  }

  const statuses = application.attempts.map((attempt) => attempt.status);

  if (statuses.includes("cancelled")) return "archived";

  // CHECKED BEFORE acceptedEvidence, because 'submitting' is the state an unverified
  // extension report leaves behind and it must not be filtered into "In progress".
  if (statuses.includes("submitting")) return "needs_verification";

  // 'action_required' carries its own label already ("Needs your input"); it is surfaced
  // as Action Required because that is what it asks of the candidate.
  if (statuses.includes("action_required")) return "needs_verification";

  // "succeeded" is a receipt-backed acceptance on the attempt itself, which is what
  // makes an application Applied - the status alone is a claim the worker made.
  if (application.attempts.some((attempt) => attempt.acceptedEvidence)) return "applied";

  return "in_progress";
}

/** The most recent thing that happened to this application. */
export function lastTouched(application: ApplicationSummary): string {
  const stamps = application.attempts.map((attempt) => attempt.updatedAt);
  return stamps.length > 0 ? stamps.sort().slice(-1)[0] : application.createdAt;
}

function relativeTime(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.round(hours / 24);
  if (days < 30) return days + "d ago";
  return Math.round(days / 30) + "mo ago";
}

function initials(company: string): string {
  return company
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function TrackerPage() {
  const [applications, setApplications] = useState<ApplicationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | TrackerStage>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumped after an approval so the list re-reads. The approve call changes the attempt's
  // server-side status, and a tracker still showing "Awaiting your review" after the
  // candidate approved it would be showing a state that no longer exists.
  const [reloadToken, setReloadToken] = useState(0);

  const now = useMemo(() => Date.now(), []);

  useEffect(() => {
    let cancelled = false;

    listApplications(getSupabaseBrowserClient())
      .then((result) => {
        if (cancelled) return;
        if (result.kind === "error") {
          setError(result.message);
          return;
        }
        setApplications(result.applications);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const entries = useMemo(
    () =>
      (applications ?? []).map((application) => ({
        application,
        stage: stageOf(application),
        company: application.companyName ?? "Unknown company",
        touched: lastTouched(application),
      })),
    [applications],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (filter !== "all" && entry.stage !== filter) return false;
      if (needle === "") return true;
      return (
        entry.company.toLowerCase().includes(needle) ||
        entry.application.vacancyTitle.toLowerCase().includes(needle)
      );
    });
  }, [entries, query, filter]);

  const selected = visible.find((entry) => entry.application.planId === selectedId) ?? null;

  if (applications === null && error === null) {
    return (
      <div className="flex items-center gap-3 p-6 text-sm text-ios-text-secondary">
        <Spinner /> Loading your applications...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold text-black">Tracker</h1>
        <p className="mt-1 text-sm text-ios-text-secondary">
          Every application you have sent, and what came back.
        </p>
      </header>

      {/* A FAILED READ IS NOT AN EMPTY TRACKER. Saying "no applications" when the query
          failed would tell a candidate their applications had vanished. */}
      {error !== null ? (
        <p role="alert" className="rounded-card border border-status-blocked/40 bg-status-blocked/10 p-4 text-sm text-status-blocked-fg">
          Could not load your applications: {error}
        </p>
      ) : null}

      <div className="space-y-3 rounded-card border border-ios-separator bg-ios-card p-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ios-text-secondary"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by company or role"
            aria-label="Search applications"
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
          {FILTERS.map((option) => {
            const active = filter === option.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(option.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  active
                    ? "border-ios-blue bg-ios-blue text-white"
                    : "border-ios-separator bg-ios-card text-ios-text hover:border-ios-blue/40",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <section
          aria-label="Applications"
          className="max-h-[70vh] space-y-2 overflow-y-auto rounded-card border border-ios-separator bg-ios-card p-2"
        >
          {visible.length === 0 ? (
            <p className="p-4 text-sm text-ios-text-secondary">
              {entries.length === 0
                ? "You have not applied to anything yet. Jobs you apply to will appear here."
                : "No applications match this search or filter."}
            </p>
          ) : (
            visible.map((entry) => {
              const stage = STAGE[entry.stage];
              const active = entry.application.planId === selected?.application.planId;
              return (
                <button
                  key={entry.application.planId}
                  type="button"
                  onClick={() => setSelectedId(entry.application.planId)}
                  aria-current={active}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-control border p-3 text-left transition-colors",
                    active ? "border-ios-blue bg-ios-blue/5" : "border-ios-separator bg-ios-card hover:bg-ios-bg",
                  )}
                >
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-ios-separator bg-ios-bg text-xs font-semibold text-ios-text-secondary"
                    aria-hidden="true"
                  >
                    {initials(entry.company)}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-black">{entry.company}</span>
                      <span className="shrink-0 text-[11px] text-ios-text-secondary">
                        {relativeTime(entry.touched, now)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-ios-text-secondary">
                      {entry.application.vacancyTitle}
                    </span>
                    <span
                      className={cn(
                        "mt-1.5 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                        stage.badge,
                      )}
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", stage.dot)} aria-hidden="true" />
                      {stage.label}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </section>

        <section
          aria-label="Application detail"
          className="min-h-[420px] rounded-card border border-ios-separator bg-ios-card p-5"
        >
          {!selected ? (
            <div className="flex h-full min-h-[380px] flex-col items-center justify-center text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ios-bg">
                <Search className="h-5 w-5 text-ios-text-secondary" aria-hidden="true" />
              </span>
              <p className="mt-3 text-sm font-medium text-black">Select a message to read</p>
              <p className="mt-1 max-w-xs text-xs text-ios-text-secondary">
                Pick an application on the left to see where it stands.
              </p>
            </div>
          ) : (
            <article>
              <div className="flex items-start gap-3 border-b border-ios-separator pb-4">
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-ios-separator bg-ios-bg text-sm font-semibold text-ios-text-secondary"
                  aria-hidden="true"
                >
                  {initials(selected.company)}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-base font-semibold text-black">
                    {selected.application.vacancyTitle}
                  </h2>
                  <p className="mt-0.5 text-sm text-ios-text-secondary">{selected.company}</p>
                  <p className="mt-1.5 flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                        STAGE[selected.stage].badge,
                      )}
                    >
                      <span
                        className={cn("h-1.5 w-1.5 rounded-full", STAGE[selected.stage].dot)}
                        aria-hidden="true"
                      />
                      {STAGE[selected.stage].label}
                    </span>
                    <span className="text-xs text-ios-text-secondary">
                      {relativeTime(selected.touched, now)}
                    </span>
                  </p>
                </div>
              </div>

              {selected.stage === "needs_verification" ? (
                <p
                  role="status"
                  className="mt-4 rounded-control border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked-fg"
                >
                  <span className="font-semibold">Action Required: Verify Submission.</span>{" "}
                  We could not confirm this application was received. Check the employer&apos;s site or your
                  email, and apply again if it is not there.
                </p>
              ) : null}

              {selected.application.ineligibleReason !== null ? (
                <p className="mt-4 rounded-control border border-status-under-review/40 bg-status-under-review/10 p-3 text-xs text-status-under-review-fg">
                  {selected.application.ineligibleReason}
                </p>
              ) : null}

              {selected.application.responseCategories.length > 0 ? (
                <div className="mt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ios-text-secondary">
                    Replies received
                  </h3>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {selected.application.responseCategories.map((category) => (
                      <li
                        key={category}
                        className="rounded-full border border-ios-separator bg-ios-bg px-2.5 py-1 text-xs text-ios-text"
                      >
                        {category.replace(/_/g, " ")}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="mt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ios-text-secondary">
                  Submission
                </h3>
                {selected.application.attempts.length === 0 ? (
                  <p className="mt-2 text-sm text-ios-text-secondary">
                    No submission has been attempted yet.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {selected.application.attempts.map((attempt) => (
                      <li
                        key={attempt.id}
                        className="rounded-control border border-ios-separator bg-ios-bg p-2.5 text-sm"
                      >
                        <p className="font-medium text-black">
                          {ATTEMPT_STATUS_LABELS[attempt.status] ?? attempt.status}
                        </p>
                        <p className="mt-0.5 text-xs text-ios-text-secondary">
                          Attempt {attempt.attempts} of {attempt.maxAttempts} ·{" "}
                          {relativeTime(attempt.updatedAt, now)}
                        </p>
                        {attempt.evidence.length > 0 ? (
                          <ul className="mt-1.5 space-y-0.5">
                            {attempt.evidence.map((item) => (
                              <li key={item.id} className="text-xs text-ios-text-secondary">
                                <span className="font-medium text-ios-text">{item.title}</span>
                                {item.details.map((detail, index) => (
                                  <span key={index} className="block">
                                    {detail}
                                  </span>
                                ))}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {attempt.lastError !== null ? (
                          <p className="mt-1.5 text-xs text-status-blocked-fg">{attempt.lastError}</p>
                        ) : null}

                        {/* THE REVIEW GATE, MOVED HERE FROM THE RETIRED APPLICATIONS PAGE.
                            This is the only path in the product to approve a pending_review
                            attempt, so the Tracker has to carry it or those applications are
                            stranded awaiting a review with no button to give. */}
                        {attempt.status === "pending_review" ? (
                          <AttemptReview
                            attemptId={attempt.id}
                            onApproved={() => setReloadToken((token) => token + 1)}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {safeVacancyHref(selected.application.vacancyUrl) !== null ? (
                <a
                  href={appendAttemptId(safeVacancyHref(selected.application.vacancyUrl) ?? "#", selected.application.attempts[0]?.id)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-ios-blue"
                >
                  Open the job posting
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              ) : null}
            </article>
          )}
        </section>
      </div>
    </div>
  );
}
