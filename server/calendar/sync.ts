import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CalendarSyncTokenInvalidError,
  listAllCalendarEvents,
  type GoogleCalendarEvent,
} from "./client.js";
import {
  GoogleRefreshTokenInvalidError,
  refreshGoogleAccessToken,
  type FetchImpl,
  type GoogleOAuthConfig,
  type StoredMailboxTokenBundle,
} from "../mailbox/oauth.js";
import { decryptMailboxSecret, encryptMailboxSecret } from "../mailbox/tokenCrypto.js";

/**
 * Task H2 — Google Calendar sync (RI PRD FR-012, §13.1, §13.3, §7.1, §7.2).
 *
 * DETECTS CREATION, CHANGE, RESCHEDULE AND CANCELLATION. All four come from the
 * same incremental pull: events.list with showDeleted=true returns cancelled
 * events as items with status 'cancelled', and everything else as the current
 * state. Comparing that against the stored row is what separates "created" from
 * "rescheduled" from "merely updated".
 *
 * THE CANDIDATE'S WHOLE CALENDAR IS NOT AN INTERVIEW LIST. A calendar holds
 * dentist appointments, standups and birthdays. Writing every event into
 * interviews would make the table useless and would put non-interviews in front
 * of the candidate as tracked opportunities. So an event becomes an interview
 * ONLY when it can be linked to one of the candidate's applications — by a
 * company domain on an attendee or the organiser, or by the company's name
 * appearing in the event text. That is RI PRD §8.2's "Company domain + exact
 * role title" evidence tier at the domain half; unlinked events are COUNTED and
 * SKIPPED rather than stored, and the count is reported so the decision is
 * visible instead of silent.
 *
 * §13.3's "cancelled is not a rejection" IS ENFORCED HERE BY OMISSION. Nothing
 * in this module writes to application_attempts, application_plans or any
 * vacancy status. A cancelled interview sets interviews.status = 'cancelled' and
 * records a change row. It cannot demote an application, because there is no
 * code path from here that could.
 */

/** In-flight claim lock, same shape and rationale as poll.ts's LEASE_DURATION_MS. */
const LEASE_DURATION_MS = 2 * 60 * 1000;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
/** Same ceiling as the mail poll: five consecutive transient failures parks the connection until the candidate reconnects. */
const MAX_TRANSIENT_FAILURES = 5;
/**
 * How far back a first-ever sync looks. RI PRD Appendix C records the founder's
 * decision of a 90-day initial mailbox window; the same window is used here so
 * the two channels cannot disagree about how much history exists.
 */
const INITIAL_SYNC_LOOKBACK_DAYS = 90;

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

/** Bounds what reaches interviews.description; a long agenda is not an instruction sheet. */
const MAX_INSTRUCTIONS_CHARS = 4000;

export interface ClaimedCalendarConnection {
  id: string;
  candidate_id: string;
  email_address: string | null;
  secret_manager_key: string | null;
  granted_scopes: string[] | null;
  calendar_sync_token: string | null;
  calendar_sync_failure_count: number;
}

export interface CalendarSyncResult {
  connectionId: string;
  outcome: "success" | "transient_error" | "terminal_error" | "skipped";
  skippedBecause?: string;
  fetched: number;
  created: number;
  rescheduled: number;
  updated: number;
  cancelled: number;
  unchanged: number;
  skippedUnlinked: number;
  /** True when a 410 forced a full resync this run. */
  resynced: boolean;
  error?: string;
}

export interface CalendarSyncBatchResult {
  connections: number;
  created: number;
  rescheduled: number;
  updated: number;
  cancelled: number;
  skippedUnlinked: number;
  failures: number;
}

/**
 * Claims every due connected Google connection via UPDATE ... RETURNING, the
 * same "let the WHERE clause decide" claim poll.ts uses, on its own lease column
 * so a mail poll and a calendar sync never block each other.
 */
export async function claimCalendarConnections(
  client: SupabaseClient,
): Promise<ClaimedCalendarConnection[]> {
  const nowIso = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + LEASE_DURATION_MS).toISOString();

  const { data, error } = await client
    .from("mailbox_connections")
    .update({ calendar_leased_until: leaseUntil })
    .eq("status", "connected")
    .eq("provider", "gmail")
    .or("calendar_leased_until.is.null,calendar_leased_until.lt." + nowIso)
    .select("id, candidate_id, email_address, secret_manager_key, granted_scopes, calendar_sync_token, calendar_sync_failure_count");

  if (error) {
    throw error;
  }

  return (data ?? []) as ClaimedCalendarConnection[];
}

interface ApplicationLink {
  applicationAttemptId: string;
  companyName: string;
  domains: string[];
}

/**
 * The candidate's applications with the company identity needed to recognise one
 * in a calendar invite.
 *
 * Four flat queries joined here rather than one embedded PostgREST select,
 * because an embedded to-one relation comes back typed as an array and the cast
 * that hides is exactly what would let a missing company silently become an
 * unmatched application.
 */
async function loadApplicationLinks(client: SupabaseClient, candidateId: string): Promise<ApplicationLink[]> {
  const { data: plans, error: planError } = await client
    .from("application_plans")
    .select("id, vacancy_id")
    .eq("candidate_id", candidateId);

  if (planError) {
    throw planError;
  }

  const planRows = (plans ?? []) as Array<{ id: string; vacancy_id: string }>;
  if (planRows.length === 0) {
    return [];
  }

  const vacancyIds = [...new Set(planRows.map((row) => row.vacancy_id))];

  const { data: vacancies, error: vacancyError } = await client
    .from("vacancies")
    .select("id, company_id")
    .in("id", vacancyIds);

  if (vacancyError) {
    throw vacancyError;
  }

  const vacancyRows = (vacancies ?? []) as Array<{ id: string; company_id: string | null }>;
  const companyIds = [...new Set(vacancyRows.map((row) => row.company_id).filter((id): id is string => id !== null))];

  const companiesById = new Map<string, { displayed_name: string | null; domain: string | null; career_domain: string | null }>();

  if (companyIds.length > 0) {
    const { data: companies, error: companyError } = await client
      .from("companies")
      .select("id, displayed_name, domain, career_domain")
      .in("id", companyIds);

    if (companyError) {
      throw companyError;
    }

    for (const row of (companies ?? []) as Array<{ id: string; displayed_name: string | null; domain: string | null; career_domain: string | null }>) {
      companiesById.set(row.id, row);
    }
  }

  const { data: attempts, error: attemptError } = await client
    .from("application_attempts")
    .select("id, application_plan_id")
    .in("application_plan_id", planRows.map((row) => row.id));

  if (attemptError) {
    throw attemptError;
  }

  const attemptByPlan = new Map<string, string>();
  for (const row of (attempts ?? []) as Array<{ id: string; application_plan_id: string }>) {
    attemptByPlan.set(row.application_plan_id, row.id);
  }

  const vacancyCompany = new Map(vacancyRows.map((row) => [row.id, row.company_id]));
  const links: ApplicationLink[] = [];

  for (const plan of planRows) {
    const attemptId = attemptByPlan.get(plan.id);
    if (!attemptId) {
      continue;
    }

    const companyId = vacancyCompany.get(plan.vacancy_id) ?? null;
    const company = companyId ? companiesById.get(companyId) ?? null : null;

    links.push({
      applicationAttemptId: attemptId,
      companyName: (company?.displayed_name ?? "").toLowerCase(),
      domains: [company?.domain, company?.career_domain]
        .filter((domain): domain is string => typeof domain === "string" && domain.length > 0)
        .map((domain) => domain.toLowerCase().replace(/^www\./, "")),
    });
  }

  return links;
}

function emailDomain(address: string | undefined): string | null {
  if (!address) {
    return null;
  }
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) {
    return null;
  }
  return address.slice(at + 1).toLowerCase();
}

/**
 * Links an event to an application, or reports that it could not.
 *
 * The candidate's own domain is excluded so their personal address cannot match
 * a company, and a company name must be at least four characters before it is
 * searched for in the text — shorter names match inside unrelated words and
 * would link interviews to the wrong employer.
 */
function linkEvent(
  event: GoogleCalendarEvent,
  applications: ApplicationLink[],
  candidateDomain: string | null,
): { link: ApplicationLink; reason: string } | null {
  const eventDomains = new Set<string>();

  for (const address of [event.organizer?.email, ...(event.attendees ?? []).map((attendee) => attendee.email)]) {
    const domain = emailDomain(address);
    if (domain && domain !== candidateDomain) {
      eventDomains.add(domain);
    }
  }

  for (const application of applications) {
    const matchedDomain = application.domains.find((domain) => eventDomains.has(domain));
    if (matchedDomain) {
      return { link: application, reason: "company domain " + matchedDomain };
    }
  }

  const text = ((event.summary ?? "") + " " + (event.description ?? "")).toLowerCase();

  for (const application of applications) {
    if (application.companyName.length >= 4 && text.includes(application.companyName)) {
      return { link: application, reason: "company name in the event text" };
    }
  }

  return null;
}

function conferenceEntry(event: GoogleCalendarEvent, type: string): string | null {
  const entry = (event.conferenceData?.entryPoints ?? []).find((point) => point.entryPointType === type);
  return entry?.uri ?? null;
}

/**
 * Normalises a Google dateTime to UTC ISO.
 *
 * NOT OPTIONAL. Google sends the wall-clock time with the event's own offset
 * ("2026-09-25T14:00:00+05:30"); Postgres stores a timestamptz normalised to UTC
 * and hands back "2026-09-25T08:30:00.000Z". Storing the raw string and then
 * comparing it against the stored value on the next sync would find the two
 * different for EVERY event, so every event would be reported as rescheduled on
 * every run — a false reschedule on the candidate's whole calendar, forever.
 * Normalising once, here, is what makes the comparison mean something.
 */
function toUtcIso(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function durationMinutes(event: GoogleCalendarEvent): number | null {
  const start = event.start?.dateTime;
  const end = event.end?.dateTime;
  if (!start || !end) {
    return null;
  }
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  return Math.round(ms / 60000);
}

interface InterviewValues {
  application_attempt_id: string | null;
  calendar_connection_id: string;
  calendar_event_id: string;
  scheduled_at: string | null;
  timezone: string | null;
  duration_minutes: number | null;
  status: string;
  round: string | null;
  interviewers: string[] | null;
  recruiter_name: string | null;
  meeting_url: string | null;
  dial_in: string | null;
  location: string | null;
  instructions: string | null;
  backup_contact: string | null;
  external_updated_at: string | null;
  raw_payload: unknown;
}

function toInterviewValues(
  event: GoogleCalendarEvent,
  connectionId: string,
  applicationAttemptId: string | null,
): InterviewValues {
  const self = (event.attendees ?? []).find((attendee) => attendee.self === true);

  // §13.1 Lifecycle. The invitation is 'invited' unless the candidate's own
  // attendee record already says they accepted, which is the one lifecycle value
  // a calendar can establish on its own.
  const status = self?.responseStatus === "accepted" ? "accepted" : "invited";

  const interviewers = (event.attendees ?? [])
    .filter((attendee) => attendee.self !== true && attendee.organizer !== true)
    .map((attendee) => attendee.displayName ?? attendee.email ?? "")
    .filter((name) => name.length > 0);

  return {
    application_attempt_id: applicationAttemptId,
    calendar_connection_id: connectionId,
    calendar_event_id: event.id,
    scheduled_at: toUtcIso(event.start?.dateTime),
    timezone: event.start?.timeZone ?? null,
    duration_minutes: durationMinutes(event),
    status,
    // Round is not derivable from a free-text summary without inventing a
    // convention, so it stays null rather than being guessed from the title.
    round: null,
    interviewers: interviewers.length > 0 ? interviewers : null,
    recruiter_name: event.organizer?.self === true ? null : event.organizer?.displayName ?? event.organizer?.email ?? null,
    meeting_url: event.hangoutLink ?? conferenceEntry(event, "video") ?? null,
    dial_in: conferenceEntry(event, "phone") ?? null,
    location: event.location ?? null,
    instructions: event.description ? event.description.slice(0, MAX_INSTRUCTIONS_CHARS) : null,
    // Nothing in a calendar event is a backup contact in the PRD's sense.
    backup_contact: null,
    external_updated_at: event.updated ?? null,
    raw_payload: event,
  };
}

const TRACKED_FIELDS: Array<keyof InterviewValues> = [
  "scheduled_at",
  "timezone",
  "duration_minutes",
  "meeting_url",
  "dial_in",
  "location",
  "instructions",
  "interviewers",
  "recruiter_name",
  "status",
];

function describeChange(before: InterviewValues, after: InterviewValues): string {
  const parts: string[] = [];
  for (const field of TRACKED_FIELDS) {
    const from = before[field];
    const to = after[field];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      parts.push(field + ": " + JSON.stringify(from) + " -> " + JSON.stringify(to));
    }
  }
  return parts.join("; ");
}

interface ExistingInterview {
  id: string;
  application_attempt_id: string | null;
  status: string;
  scheduled_at: string | null;
  timezone: string | null;
  duration_minutes: number | null;
  meeting_url: string | null;
  dial_in: string | null;
  location: string | null;
  instructions: string | null;
  interviewers: string[] | null;
  recruiter_name: string | null;
  external_updated_at: string | null;
}

async function recordChange(
  client: SupabaseClient,
  interviewId: string,
  changeType: string,
  summary: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  const { error } = await client.from("interview_event_changes").insert({
    interview_id: interviewId,
    change_type: changeType,
    source: "calendar",
    summary,
    previous_values: before ?? null,
    new_values: after ?? null,
  });

  if (error) {
    throw error;
  }
}

function toComparable(existing: ExistingInterview): InterviewValues {
  return {
    application_attempt_id: existing.application_attempt_id,
    calendar_connection_id: "",
    calendar_event_id: "",
    scheduled_at: existing.scheduled_at,
    timezone: existing.timezone,
    duration_minutes: existing.duration_minutes,
    status: existing.status,
    round: null,
    interviewers: existing.interviewers,
    recruiter_name: existing.recruiter_name,
    meeting_url: existing.meeting_url,
    dial_in: existing.dial_in,
    location: existing.location,
    instructions: existing.instructions,
    backup_contact: null,
    external_updated_at: existing.external_updated_at,
    raw_payload: null,
  };
}

/** Never throws — every failure is a result, mirroring pollOneMailboxConnection. */
export async function syncOneCalendarConnection(
  client: SupabaseClient,
  connection: ClaimedCalendarConnection,
  config: GoogleOAuthConfig,
  encryptionKey: Buffer,
  fetchImpl: FetchImpl = fetch,
): Promise<CalendarSyncResult> {
  const base: CalendarSyncResult = {
    connectionId: connection.id,
    outcome: "success",
    fetched: 0,
    created: 0,
    rescheduled: 0,
    updated: 0,
    cancelled: 0,
    unchanged: 0,
    skippedUnlinked: 0,
    resynced: false,
  };

  const scopes = connection.granted_scopes ?? [];
  if (!scopes.includes(CALENDAR_SCOPE)) {
    // A connection made before the calendar scope was requested. Reported as
    // skipped rather than failed: nothing is broken, the candidate simply has
    // not consented to calendar access yet, and the fix is to reconnect.
    return { ...base, outcome: "skipped", skippedBecause: "calendar scope not granted — reconnect to enable calendar sync" };
  }

  if (!connection.secret_manager_key) {
    await markTerminalError(client, connection.id, "Missing stored credentials.");
    return { ...base, outcome: "terminal_error", error: "Missing stored credentials." };
  }

  let bundle: StoredMailboxTokenBundle;
  try {
    bundle = JSON.parse(decryptMailboxSecret(encryptionKey, connection.secret_manager_key)) as StoredMailboxTokenBundle;
  } catch {
    const message = "Stored credentials could not be decrypted.";
    await markTerminalError(client, connection.id, message);
    return { ...base, outcome: "terminal_error", error: message };
  }

  try {
    let accessToken = bundle.accessToken;

    if (bundle.expiresAt <= Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
      const refreshed = await refreshGoogleAccessToken(config, bundle.refreshToken, fetchImpl);
      accessToken = refreshed.accessToken;
      bundle = { ...bundle, accessToken, expiresAt: refreshed.expiresAt };

      const { error } = await client
        .from("mailbox_connections")
        .update({ secret_manager_key: encryptMailboxSecret(encryptionKey, JSON.stringify(bundle)) })
        .eq("id", connection.id);

      if (error) {
        throw error;
      }
    }

    let syncToken = connection.calendar_sync_token;
    let resynced = false;
    let events: GoogleCalendarEvent[];
    let nextSyncToken: string | null;

    try {
      const page = await listAllCalendarEvents(accessToken, { syncToken, fetchImpl });
      events = page.events;
      nextSyncToken = page.nextSyncToken;
    } catch (error) {
      if (!(error instanceof CalendarSyncTokenInvalidError)) {
        throw error;
      }

      // §7.1's documented fallback: a bounded full resync. The token is dropped
      // first so a failure during the resync cannot leave a token that is known
      // to be invalid.
      const lookback = new Date(Date.now() - INITIAL_SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const page = await listAllCalendarEvents(accessToken, { timeMin: lookback, fetchImpl });
      events = page.events;
      nextSyncToken = page.nextSyncToken;
      syncToken = null;
      resynced = true;
    }

    const applications = await loadApplicationLinks(client, connection.candidate_id);
    const candidateDomain = emailDomain(connection.email_address ?? undefined);
    const result: CalendarSyncResult = { ...base, fetched: events.length, resynced };

    for (const event of events) {
      // An all-day event has a date and no clock time, so it is not an interview
      // slot. Counted with the unlinked rather than written with a null time.
      if (!event.start?.dateTime) {
        result.skippedUnlinked += 1;
        continue;
      }

      const { data: existingRows, error: existingError } = await client
        .from("interviews")
        .select("id, application_attempt_id, status, scheduled_at, timezone, duration_minutes, meeting_url, dial_in, location, instructions, interviewers, recruiter_name, external_updated_at")
        .eq("calendar_connection_id", connection.id)
        .eq("calendar_event_id", event.id);

      if (existingError) {
        throw existingError;
      }

      const existing = ((existingRows ?? []) as ExistingInterview[])[0] ?? null;

      if (event.status === "cancelled") {
        if (!existing) {
          result.skippedUnlinked += 1;
          continue;
        }
        if (existing.status === "cancelled") {
          result.unchanged += 1;
          continue;
        }

        const { error } = await client
          .from("interviews")
          .update({ status: "cancelled", external_updated_at: event.updated ?? null, last_synced_at: new Date().toISOString() })
          .eq("id", existing.id);

        if (error) {
          throw error;
        }

        await recordChange(client, existing.id, "cancelled", "Cancelled in the calendar.", { status: existing.status }, { status: "cancelled" });
        result.cancelled += 1;
        continue;
      }

      const linked = linkEvent(event, applications, candidateDomain);

      if (!existing && !linked) {
        result.skippedUnlinked += 1;
        continue;
      }

      if (!existing) {
        // Only reachable with a link (the !existing && !linked case returned
        // above), so the application id here is always a real one.
        const values = toInterviewValues(event, connection.id, linked!.link.applicationAttemptId);

        const { data: inserted, error } = await client
          .from("interviews")
          .insert({ ...values, source: "calendar", last_synced_at: new Date().toISOString() })
          .select("id")
          .single();

        if (error || !inserted) {
          throw error ?? new Error("Interview insert returned no row.");
        }

        await recordChange(
          client,
          (inserted as { id: string }).id,
          "created",
          "Interview detected in the calendar (" + (linked?.reason ?? "already known") + ").",
          null,
          { scheduled_at: values.scheduled_at, timezone: values.timezone, status: values.status },
        );
        result.created += 1;
        continue;
      }

      // A re-sync of an unchanged event (which a 410 full resync produces for
      // everything) must not write a second change row.
      if (existing.external_updated_at && event.updated && existing.external_updated_at === event.updated && existing.status !== "cancelled") {
        result.unchanged += 1;
        continue;
      }

      // An existing row keeps its application link: re-linking on every edit
      // would let a summary tweak detach an interview from its application.
      const values = toInterviewValues(event, connection.id, existing.application_attempt_id);
      const before = toComparable(existing);
      const after = values;

      const scheduleMoved = existing.scheduled_at !== values.scheduled_at;
      const changeType = scheduleMoved ? "rescheduled" : "updated";

      const { error } = await client
        .from("interviews")
        .update({
          scheduled_at: values.scheduled_at,
          timezone: values.timezone,
          duration_minutes: values.duration_minutes,
          meeting_url: values.meeting_url,
          dial_in: values.dial_in,
          location: values.location,
          instructions: values.instructions,
          interviewers: values.interviewers,
          recruiter_name: values.recruiter_name,
          status: scheduleMoved ? "rescheduled" : values.status,
          external_updated_at: values.external_updated_at,
          last_synced_at: new Date().toISOString(),
        })
        .eq("id", existing.id);

      if (error) {
        throw error;
      }

      const detail = describeChange(before, after);
      await recordChange(
        client,
        existing.id,
        changeType,
        scheduleMoved
          ? "Rescheduled in the calendar. " + detail
          : "Updated in the calendar. " + detail,
        before,
        after,
      );

      if (scheduleMoved) {
        result.rescheduled += 1;
      } else {
        result.updated += 1;
      }
    }

    // Only a token returned by a fully-drained page walk is stored; see
    // listAllCalendarEvents.
    const { error: persistError } = await client
      .from("mailbox_connections")
      .update({
        calendar_sync_token: nextSyncToken ?? syncToken,
        calendar_last_synced_at: new Date().toISOString(),
        calendar_last_sync_error: null,
        calendar_sync_failure_count: 0,
      })
      .eq("id", connection.id);

    if (persistError) {
      throw persistError;
    }

    return result;
  } catch (error) {
    if (error instanceof GoogleRefreshTokenInvalidError) {
      const message = "Google refresh token was rejected; the connection needs reconnecting.";
      await markTerminalError(client, connection.id, message);
      return { ...base, outcome: "terminal_error", error: message };
    }

    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("invalid_grant") || message.includes("insufficient") || message.includes("403")) {
      await markTerminalError(client, connection.id, message);
      return { ...base, outcome: "terminal_error", error: message };
    }

    await markTransientFailure(client, connection, message);
    return { ...base, outcome: "transient_error", error: message };
  }
}

async function markTerminalError(client: SupabaseClient, connectionId: string, message: string): Promise<void> {
  const { error } = await client
    .from("mailbox_connections")
    .update({ status: "error", calendar_last_sync_error: message })
    .eq("id", connectionId);

  if (error) {
    console.error("[calendar:sync] failed to record terminal error", { connectionId, error });
  }
}

/**
 * Counts a transient failure and parks the connection at the same ceiling the
 * mail poll uses. The lease is released so the next run retries rather than
 * waiting out the full lease on a failure that took milliseconds.
 */
async function markTransientFailure(
  client: SupabaseClient,
  connection: ClaimedCalendarConnection,
  message: string,
): Promise<void> {
  const failures = (connection.calendar_sync_failure_count ?? 0) + 1;

  const { error } = await client
    .from("mailbox_connections")
    .update({
      calendar_sync_failure_count: failures,
      calendar_last_sync_error: message,
      calendar_leased_until: null,
      ...(failures >= MAX_TRANSIENT_FAILURES ? { status: "error" } : {}),
    })
    .eq("id", connection.id);

  if (error) {
    console.error("[calendar:sync] failed to record transient failure", { connectionId: connection.id, error });
  }
}

/** Drains every due connection. A failure of the claim query itself propagates; per-connection failures do not. */
export async function runCalendarSyncBatch(
  client: SupabaseClient,
  config: GoogleOAuthConfig,
  encryptionKey: Buffer,
  fetchImpl: FetchImpl = fetch,
): Promise<CalendarSyncBatchResult> {
  const connections = await claimCalendarConnections(client);

  const total: CalendarSyncBatchResult = {
    connections: connections.length,
    created: 0,
    rescheduled: 0,
    updated: 0,
    cancelled: 0,
    skippedUnlinked: 0,
    failures: 0,
  };

  for (const connection of connections) {
    const result = await syncOneCalendarConnection(client, connection, config, encryptionKey, fetchImpl);

    total.created += result.created;
    total.rescheduled += result.rescheduled;
    total.updated += result.updated;
    total.cancelled += result.cancelled;
    total.skippedUnlinked += result.skippedUnlinked;

    if (result.outcome === "transient_error" || result.outcome === "terminal_error") {
      total.failures += 1;
      console.error("[calendar:sync] connection failed", {
        connectionId: result.connectionId,
        outcome: result.outcome,
        error: result.error,
      });
    }
  }

  return total;
}
