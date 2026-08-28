import type { MailboxMessage } from "./mailboxMessages";

/**
 * Response Intelligence Phase 2 — the "Today" dashboard grouping.
 *
 * Pure transform: takes the candidate's classified messages (from
 * listMessages) and buckets them into a fixed, priority-ordered set of
 * sections for the Overview page. No I/O — the panel does the fetching.
 *
 * Section order IS the priority order: what needs the candidate to act
 * comes first, rejections last. `response_classifications` has a
 * unique(message_id) index (Phase 1), so a message has at most one
 * classification — `classifications[0]` is authoritative; a message with
 * none is not shown here at all.
 */
export const TODAY_SECTIONS = [
  { key: "action_required", title: "Action Required", categories: ["action_required"] },
  { key: "interviews", title: "Interviews", categories: ["interview"] },
  { key: "offers", title: "Offers", categories: ["offer"] },
  { key: "updates", title: "Updates", categories: ["recruiter_followup", "application_received", "other"] },
  { key: "rejections", title: "Rejections", categories: ["rejection"] },
] as const;

export type TodaySectionKey = (typeof TODAY_SECTIONS)[number]["key"];

export type DeadlineUrgency = "overdue" | "soon" | "later";

/** A deadline this many days out or nearer (and not past) is "soon". */
export const DEADLINE_SOON_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Unknown / future-proofing categories land in "Updates" rather than being dropped. */
const FALLBACK_SECTION: TodaySectionKey = "updates";

const CATEGORY_TO_SECTION = new Map<string, TodaySectionKey>(
  TODAY_SECTIONS.flatMap((section) => section.categories.map((category) => [category, section.key])),
);

export function categoryToSectionKey(category: string): TodaySectionKey {
  return CATEGORY_TO_SECTION.get(category) ?? FALLBACK_SECTION;
}

/**
 * `deadline` is a calendar day (YYYY-MM-DD from a Postgres `date`), so the
 * comparison is by whole days in UTC — a deadline "today" is "soon", not
 * "overdue", regardless of the current time of day.
 */
export function deadlineUrgency(deadline: string | null, now: Date = new Date()): DeadlineUrgency | null {
  if (!deadline) {
    return null;
  }

  const due = new Date(`${deadline}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) {
    return null;
  }

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diffDays = Math.round((due.getTime() - today) / MS_PER_DAY);

  if (diffDays < 0) {
    return "overdue";
  }
  if (diffDays <= DEADLINE_SOON_DAYS) {
    return "soon";
  }
  return "later";
}

export interface TodayItem {
  messageId: string;
  subject: string | null;
  sender: string | null;
  receivedAt: string | null;
  category: string;
  company: string | null;
  role: string | null;
  jobId: string | null;
  deadline: string | null;
  deadlineUrgency: DeadlineUrgency | null;
  salaryText: string | null;
}

export interface TodaySection {
  key: TodaySectionKey;
  title: string;
  items: TodayItem[];
}

/** Deadlines first (soonest calendar day asc), then the rest newest-received first. */
function compareItems(a: TodayItem, b: TodayItem): number {
  if (a.deadline && b.deadline) {
    return a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0;
  }
  if (a.deadline) {
    return -1;
  }
  if (b.deadline) {
    return 1;
  }
  const ar = a.receivedAt ?? "";
  const br = b.receivedAt ?? "";
  return ar < br ? 1 : ar > br ? -1 : 0;
}

export function groupMessagesForToday(messages: MailboxMessage[], now: Date = new Date()): TodaySection[] {
  const buckets = new Map<TodaySectionKey, TodayItem[]>();

  for (const message of messages) {
    const primary = message.classifications[0];
    if (!primary) {
      continue;
    }

    const item: TodayItem = {
      messageId: message.id,
      subject: message.subject,
      sender: message.sender,
      receivedAt: message.receivedAt,
      category: primary.category,
      company: primary.extractedCompany,
      role: primary.extractedRole,
      jobId: primary.extractedJobId,
      deadline: primary.extractedDeadline,
      deadlineUrgency: deadlineUrgency(primary.extractedDeadline, now),
      salaryText: primary.extractedSalaryText,
    };

    const key = categoryToSectionKey(primary.category);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(key, [item]);
    }
  }

  return TODAY_SECTIONS.filter((section) => (buckets.get(section.key)?.length ?? 0) > 0).map((section) => ({
    key: section.key,
    title: section.title,
    items: [...buckets.get(section.key)!].sort(compareItems),
  }));
}
