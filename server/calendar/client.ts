import type { FetchImpl } from "../mailbox/oauth.js";

/**
 * Task H2 — Google Calendar, over plain fetch.
 *
 * Same "no SDK for a stable REST API" convention as gmailClient.ts,
 * mailbox/oauth.ts and companies/mcaRegistry.ts.
 */
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export class CalendarApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/**
 * A 410 from events.list means the sync token is no longer valid — Google
 * expires them, and it also invalidates them when the requested parameter set
 * changes. It is a distinct failure from a network error because the correct
 * response is a bounded full resync, not a retry with the same token (RI PRD
 * §7.1: "If history cursor is invalid or too old, perform a bounded resync").
 */
export class CalendarSyncTokenInvalidError extends Error {
  constructor() {
    super("Google Calendar sync token is no longer valid.");
    this.name = "CalendarSyncTokenInvalidError";
  }
}

export interface GoogleCalendarEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  updated?: string;
  created?: string;
  hangoutLink?: string;
  htmlLink?: string;
  start?: GoogleCalendarEventTime;
  end?: GoogleCalendarEventTime;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Array<{ email?: string; displayName?: string; self?: boolean; organizer?: boolean; responseStatus?: string }>;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }> };
  recurringEventId?: string;
  originalStartTime?: GoogleCalendarEventTime;
}

export interface ListCalendarEventsResult {
  events: GoogleCalendarEvent[];
  /** Absent on a page that is not the last one — see the paging note below. */
  nextSyncToken: string | null;
  nextPageToken: string | null;
}

export interface ListCalendarEventsOptions {
  /** Absent for the initial bounded sync; present for every incremental one. */
  syncToken?: string | null;
  /** Only used when there is no sync token — Google rejects it alongside one. */
  timeMin?: string;
  pageToken?: string | null;
  fetchImpl?: FetchImpl;
}

/** Bounded so a first-ever sync of a busy calendar cannot read forever. */
export const MAX_RESULTS_PER_PAGE = 250;

/**
 * Lists calendar events, incrementally when given a sync token.
 *
 * TWO PARAMETER RULES THAT ARE EASY TO GET WRONG, both from Google's own sync
 * documentation:
 *
 * 1. timeMin MUST NOT be sent together with a syncToken. Google rejects the
 *    combination, and the natural reading — "keep bounding the window
 *    incrementally" — produces a hard failure on every incremental run. The
 *    window bounds the INITIAL sync only.
 * 2. showDeleted MUST be true, always. Without it a cancelled event simply is
 *    not returned, so a cancellation is indistinguishable from "nothing
 *    changed" and FR-012's cancellation detection could never fire. Deleted
 *    events arrive with status 'cancelled'.
 *
 * singleEvents=true is kept on both paths so a recurring series is expanded into
 * instances rather than arriving as one master event with an RRULE; an interview
 * is a specific slot, and the same parameter set on both paths keeps the sync
 * token coherent.
 */
export async function listCalendarEvents(
  accessToken: string,
  options: ListCalendarEventsOptions = {},
): Promise<ListCalendarEventsResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(CALENDAR_API_BASE + "/calendars/primary/events");

  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("showDeleted", "true");
  url.searchParams.set("maxResults", String(MAX_RESULTS_PER_PAGE));

  if (options.syncToken) {
    url.searchParams.set("syncToken", options.syncToken);
  } else if (options.timeMin) {
    url.searchParams.set("timeMin", options.timeMin);
  }

  if (options.pageToken) {
    url.searchParams.set("pageToken", options.pageToken);
  }

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: "Bearer " + accessToken },
  });

  if (response.status === 410) {
    throw new CalendarSyncTokenInvalidError();
  }

  if (!response.ok) {
    throw new CalendarApiError("Google Calendar events.list failed: HTTP " + response.status, response.status);
  }

  const body = (await response.json()) as {
    items?: GoogleCalendarEvent[];
    nextSyncToken?: string;
    nextPageToken?: string;
  };

  return {
    events: body.items ?? [],
    // nextSyncToken is only present on the FINAL page. Storing a token from an
    // intermediate page would skip everything after it, so it is surfaced as
    // null until the caller has drained every page.
    nextSyncToken: body.nextSyncToken ?? null,
    nextPageToken: body.nextPageToken ?? null,
  };
}

/** Walks every page, returning the complete change set and the final sync token. */
export async function listAllCalendarEvents(
  accessToken: string,
  options: { syncToken?: string | null; timeMin?: string; fetchImpl?: FetchImpl } = {},
): Promise<{ events: GoogleCalendarEvent[]; nextSyncToken: string | null }> {
  const events: GoogleCalendarEvent[] = [];
  let pageToken: string | null = null;
  let nextSyncToken: string | null = null;

  // Bounded rather than while(true): a pathological or hostile response that
  // always returns a nextPageToken must not spin forever.
  for (let page = 0; page < 40; page += 1) {
    const result = await listCalendarEvents(accessToken, {
      syncToken: options.syncToken,
      timeMin: options.timeMin,
      pageToken,
      fetchImpl: options.fetchImpl,
    });

    events.push(...result.events);

    if (result.nextSyncToken) {
      nextSyncToken = result.nextSyncToken;
    }

    if (!result.nextPageToken) {
      break;
    }

    pageToken = result.nextPageToken;
  }

  return { events, nextSyncToken };
}
