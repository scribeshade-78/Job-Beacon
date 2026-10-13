import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";

/**
 * The application tracker: a list of what the candidate has sent, and what came back.
 *
 * SCAFFOLDED WITH MOCK DATA, deliberately and visibly. The real feed is the application
 * attempts the rest of this app already records; until that is wired, every card here
 * carries `isMock` and the page says so in the header. A tracker that looked real while
 * showing invented applications would be the worst kind of placeholder - a candidate
 * could reasonably believe they had applied somewhere they had not.
 */

type TrackerStatus = "applied" | "interview" | "offer" | "rejection" | "archived";

interface TrackerEntry {
  id: string;
  company: string;
  role: string;
  status: TrackerStatus;
  /** ISO, so the relative time can be derived rather than stored as prose. */
  updatedAt: string;
  subject: string;
  body: string;
}

/** Status metadata in one place, so a card and a pill cannot disagree about a colour. */
const STATUS: Record<TrackerStatus, { label: string; badge: string; dot: string }> = {
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
  archived: {
    label: "Archived",
    badge: "border-ios-separator bg-ios-bg text-ios-text-secondary",
    dot: "bg-status-action-required",
  },
};

const FILTERS: Array<{ id: "all" | TrackerStatus; label: string }> = [
  { id: "all", label: "All" },
  { id: "applied", label: "Applied" },
  { id: "interview", label: "Interview" },
  { id: "offer", label: "Offer" },
  { id: "rejection", label: "Rejection" },
  { id: "archived", label: "Archived" },
];

const MOCK: TrackerEntry[] = [
  {
    id: "t1",
    company: "Northwind Analytics",
    role: "Senior Frontend Engineer",
    status: "interview",
    updatedAt: "2026-10-11T09:20:00Z",
    subject: "Interview invitation — technical round",
    body:
      "Hi Priya,\n\nThanks for your application. We would like to invite you to a 60-minute technical interview focused on React and performance.\n\nWould Thursday or Friday afternoon work?\n\nBest,\nDana Whitfield\nTalent Partner, Northwind Analytics",
  },
  {
    id: "t2",
    company: "Halcyon Health",
    role: "Product Engineer",
    status: "offer",
    updatedAt: "2026-10-10T15:05:00Z",
    subject: "Your offer from Halcyon Health",
    body:
      "Hi Priya,\n\nWe are delighted to offer you the Product Engineer role. The attached letter covers compensation, equity and the start date.\n\nPlease let us know by the 24th if you would like to proceed.\n\nWarm regards,\nMarcus Bell",
  },
  {
    id: "t3",
    company: "Cobalt Systems",
    role: "Full Stack Developer",
    status: "applied",
    updatedAt: "2026-10-09T11:42:00Z",
    subject: "Application received",
    body:
      "Hi Priya,\n\nWe have received your application for Full Stack Developer and will review it shortly. You can expect to hear from us within two weeks.\n\nCobalt Systems Recruiting",
  },
  {
    id: "t4",
    company: "Verity Retail Group",
    role: "Frontend Engineer",
    status: "rejection",
    updatedAt: "2026-10-08T08:15:00Z",
    subject: "Update on your application",
    body:
      "Hi Priya,\n\nThank you for your interest in Verity Retail Group. After careful consideration we have decided to move forward with other candidates.\n\nWe appreciate the time you invested and wish you well.\n\nVerity Talent Team",
  },
  {
    id: "t5",
    company: "Ardent Hospitality",
    role: "Web Platform Engineer",
    status: "interview",
    updatedAt: "2026-10-07T13:30:00Z",
    subject: "Next steps — hiring manager call",
    body:
      "Hi Priya,\n\nOur hiring manager would like to speak with you for 30 minutes about the platform team and the work ahead.\n\nAre you free early next week?\n\nArdent People Team",
  },
  {
    id: "t6",
    company: "Meridian Capital",
    role: "UI Engineer",
    status: "archived",
    updatedAt: "2026-09-28T10:00:00Z",
    subject: "Role closed",
    body:
      "Hi Priya,\n\nThe UI Engineer position has been closed and we are no longer accepting applications. We will keep your details on file.\n\nMeridian Recruiting",
  },
  {
    id: "t7",
    company: "Lumen Design Studio",
    role: "Design Systems Engineer",
    status: "applied",
    updatedAt: "2026-09-26T16:45:00Z",
    subject: "Thanks for applying",
    body:
      "Hi Priya,\n\nThanks for applying to Lumen. Our team is reviewing applications now and we will be in touch.\n\nLumen Studio",
  },
];

function relativeTime(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.round(hours / 24);
  if (days < 30) return days + "d ago";
  return Math.round(days / 30) + "mo ago";
}

/** Two-letter initials, because a real logo is not available for mock entries. */
function initials(company: string): string {
  return company
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function TrackerPage() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | TrackerStatus>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // One timestamp for the whole render, so two cards cannot disagree about "now"
  // halfway down the list.
  const now = useMemo(() => Date.now(), []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return MOCK.filter((entry) => {
      if (filter !== "all" && entry.status !== filter) return false;
      if (needle === "") return true;
      return (
        entry.company.toLowerCase().includes(needle) ||
        entry.role.toLowerCase().includes(needle) ||
        entry.subject.toLowerCase().includes(needle)
      );
    });
  }, [query, filter]);

  const selected = visible.find((entry) => entry.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold text-black">Tracker</h1>
        <p className="mt-1 text-sm text-ios-text-secondary">
          Every application you have sent, and what came back.
        </p>
        {/* SAID OUT LOUD, because a placeholder that looks real is worse than none. */}
        <p className="mt-2 inline-block rounded-control border border-status-under-review/40 bg-status-under-review/10 px-2.5 py-1 text-xs font-medium text-status-under-review-fg">
          Showing sample data — not yet connected to your applications
        </p>
      </header>

      <div className="space-y-3 rounded-card border border-ios-separator bg-ios-card p-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ios-text-secondary"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by company, role or subject"
            aria-label="Search applications"
            className="pl-9"
          />
        </div>

        {/* Pills rather than a select: five statuses are few enough to show at once, and
            seeing the counts is most of what a tracker is for. */}
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
        {/* LEFT: the list. Its own scroll region, so a long list never pushes the
            reading pane off the screen. */}
        <section
          aria-label="Applications"
          className="max-h-[70vh] space-y-2 overflow-y-auto rounded-card border border-ios-separator bg-ios-card p-2"
        >
          {visible.length === 0 ? (
            <p className="p-4 text-sm text-ios-text-secondary">
              No applications match this search or filter.
            </p>
          ) : (
            visible.map((entry) => {
              const status = STATUS[entry.status];
              const active = entry.id === selected?.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSelectedId(entry.id)}
                  aria-current={active}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-control border p-3 text-left transition-colors",
                    active
                      ? "border-ios-blue bg-ios-blue/5"
                      : "border-ios-separator bg-ios-card hover:bg-ios-bg",
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
                        {relativeTime(entry.updatedAt, now)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-ios-text-secondary">
                      {entry.role}
                    </span>
                    <span className="mt-1.5 flex items-center gap-2">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                          status.badge,
                        )}
                      >
                        <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} aria-hidden="true" />
                        {status.label}
                      </span>
                    </span>
                    <span className="mt-1.5 block truncate text-xs text-ios-text-secondary">
                      {entry.subject}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </section>

        {/* RIGHT: the reading pane. */}
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
                Pick an application on the left to see the full message and where it stands.
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
                  <h2 className="truncate text-base font-semibold text-black">{selected.subject}</h2>
                  <p className="mt-0.5 text-sm text-ios-text-secondary">
                    {selected.company} · {selected.role}
                  </p>
                  <p className="mt-1.5 flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                        STATUS[selected.status].badge,
                      )}
                    >
                      <span
                        className={cn("h-1.5 w-1.5 rounded-full", STATUS[selected.status].dot)}
                        aria-hidden="true"
                      />
                      {STATUS[selected.status].label}
                    </span>
                    <span className="text-xs text-ios-text-secondary">
                      {relativeTime(selected.updatedAt, now)}
                    </span>
                  </p>
                </div>
              </div>

              {/* whitespace-pre-line so the mocked line breaks in a message body read as
                  a message rather than one run-on paragraph. */}
              <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-ios-text">
                {selected.body}
              </p>
            </article>
          )}
        </section>
      </div>
    </div>
  );
}
