import { describe, expect, it, vi } from "vitest";
import { syncOneCalendarConnection, type ClaimedCalendarConnection } from "./sync.js";
import { encryptMailboxSecret } from "../mailbox/tokenCrypto.js";
import type { GoogleOAuthConfig } from "../mailbox/oauth.js";

/**
 * FR-012 is "detect interview creation, change, reschedule and cancellation",
 * so each of those four is asserted separately here — a single "it syncs" test
 * would pass while three of the four detections were dead.
 *
 * The §13.3 rule that a cancellation is never a rejection is asserted as an
 * absence: the fake client records every table it is asked to write to, and the
 * test proves application_attempts is never among them.
 */

const KEY = Buffer.alloc(32, 7);
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const CONFIG: GoogleOAuthConfig = {
  clientId: "client",
  clientSecret: "secret",
  redirectUri: "https://app.test/callback",
};

function tokenBundle(): string {
  return encryptMailboxSecret(
    KEY,
    JSON.stringify({ accessToken: "access-token", refreshToken: "refresh-token", expiresAt: Date.now() + 3_600_000 }),
  );
}

const APPLICATION = {
  attemptId: "attempt-1",
  planId: "plan-1",
  vacancyId: "vacancy-1",
  companyId: "company-1",
  companyName: "Acme Corporation",
  domain: "acme.test",
  careerDomain: "careers.acme.test",
};

interface FakeOptions {
  scopes?: string[] | null;
  syncToken?: string | null;
  failureCount?: number;
  existingInterview?: Record<string, unknown> | null;
  includeApplication?: boolean;
  calendarResponse?: { status?: number; items?: unknown[]; nextSyncToken?: string };
}

interface Recorded {
  inserts: Array<{ table: string; payload: Record<string, unknown> }>;
  updates: Array<{ table: string; payload: Record<string, unknown> }>;
}

function makeClient(options: FakeOptions = {}) {
  const recorded: Recorded = { inserts: [], updates: [] };
  const includeApplication = options.includeApplication !== false;

  function terminalValue(table: string): { data: unknown; error: unknown } {
    if (table === "application_plans") {
      return { data: includeApplication ? [{ id: APPLICATION.planId, vacancy_id: APPLICATION.vacancyId }] : [], error: null };
    }
    if (table === "vacancies") {
      return { data: includeApplication ? [{ id: APPLICATION.vacancyId, company_id: APPLICATION.companyId }] : [], error: null };
    }
    if (table === "companies") {
      return {
        data: includeApplication
          ? [{ id: APPLICATION.companyId, displayed_name: APPLICATION.companyName, domain: APPLICATION.domain, career_domain: APPLICATION.careerDomain }]
          : [],
        error: null,
      };
    }
    if (table === "application_attempts") {
      return { data: includeApplication ? [{ id: APPLICATION.attemptId, application_plan_id: APPLICATION.planId }] : [], error: null };
    }
    if (table === "interviews") {
      return { data: options.existingInterview ? [options.existingInterview] : [], error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string): Record<string, unknown> {
    const node: Record<string, unknown> = {
      select: () => node,
      eq: () => node,
      in: () => node,
      or: () => node,
      order: () => node,
      limit: () => node,
      update: (payload: Record<string, unknown>) => {
        recorded.updates.push({ table, payload });
        return node;
      },
      insert: (payload: Record<string, unknown>) => {
        recorded.inserts.push({ table, payload });
        return node;
      },
      single: async () => ({ data: { id: "interview-new" }, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      // Awaiting the chain resolves the table's canned value.
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(terminalValue(table)).then(resolve),
    };
    return node;
  }

  return {
    client: { from: (table: string) => builder(table) } as never,
    recorded,
  };
}

function connection(overrides: Partial<ClaimedCalendarConnection> = {}): ClaimedCalendarConnection {
  return {
    id: "conn-1",
    candidate_id: "cand-1",
    email_address: "candidate@personal.test",
    secret_manager_key: tokenBundle(),
    granted_scopes: [CALENDAR_SCOPE, "https://www.googleapis.com/auth/gmail.readonly"],
    calendar_sync_token: null,
    calendar_sync_failure_count: 0,
    ...overrides,
  };
}

function calendarFetch(items: unknown[], nextSyncToken = "sync-2", status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ items, nextSyncToken }),
  })) as unknown as typeof fetch;
}

function interviewEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    status: "confirmed",
    summary: "Interview with Acme Corporation",
    updated: "2026-09-20T10:00:00.000Z",
    start: { dateTime: "2026-09-25T14:00:00+05:30", timeZone: "Asia/Kolkata" },
    end: { dateTime: "2026-09-25T15:00:00+05:30", timeZone: "Asia/Kolkata" },
    organizer: { email: "recruiter@acme.test", displayName: "Rita Recruiter" },
    attendees: [
      { email: "candidate@personal.test", self: true, responseStatus: "accepted" },
      { email: "recruiter@acme.test", organizer: true },
    ],
    ...overrides,
  };
}

describe("syncOneCalendarConnection — credentials and scope", () => {
  it("skips a connection that never granted the calendar scope, without calling Google", async () => {
    const { client } = makeClient({ scopes: ["https://www.googleapis.com/auth/gmail.readonly"] });
    const fetchImpl = calendarFetch([]);

    const result = await syncOneCalendarConnection(
      client,
      connection({ granted_scopes: ["https://www.googleapis.com/auth/gmail.readonly"] }),
      CONFIG,
      KEY,
      fetchImpl,
    );

    expect(result.outcome).toBe("skipped");
    expect(result.skippedBecause).toContain("calendar scope not granted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a missing stored credential as terminal rather than retrying forever", async () => {
    const { client } = makeClient();
    const result = await syncOneCalendarConnection(client, connection({ secret_manager_key: null }), CONFIG, KEY, calendarFetch([]));

    expect(result.outcome).toBe("terminal_error");
    expect(result.error).toContain("Missing stored credentials");
  });

  it("treats undecryptable credentials as terminal", async () => {
    const { client } = makeClient();
    const result = await syncOneCalendarConnection(
      client,
      connection({ secret_manager_key: "not-a-valid-ciphertext" }),
      CONFIG,
      KEY,
      calendarFetch([]),
    );

    expect(result.outcome).toBe("terminal_error");
  });
});

describe("syncOneCalendarConnection — creation", () => {
  it("creates an interview linked to the application whose domain is on the invite", async () => {
    const { client, recorded } = makeClient();
    const result = await syncOneCalendarConnection(client, connection(), CONFIG, KEY, calendarFetch([interviewEvent()]));

    expect(result.created).toBe(1);
    expect(result.skippedUnlinked).toBe(0);

    const interview = recorded.inserts.find((entry) => entry.table === "interviews");
    expect(interview).toBeDefined();
    expect(interview!.payload).toMatchObject({
      application_attempt_id: APPLICATION.attemptId,
      calendar_event_id: "event-1",
      source: "calendar",
      status: "accepted",
      timezone: "Asia/Kolkata",
      duration_minutes: 60,
      recruiter_name: "Rita Recruiter",
    });

    const change = recorded.inserts.find((entry) => entry.table === "interview_event_changes");
    expect(change!.payload).toMatchObject({ change_type: "created", source: "calendar" });
  });

  it("does not write an interview for an event it cannot link to any application", async () => {
    const { client, recorded } = makeClient();
    const result = await syncOneCalendarConnection(
      client,
      connection(),
      CONFIG,
      KEY,
      calendarFetch([interviewEvent({ summary: "Dentist", organizer: { email: "clinic@dentist.test" }, attendees: [] })]),
    );

    expect(result.created).toBe(0);
    expect(result.skippedUnlinked).toBe(1);
    expect(recorded.inserts.filter((entry) => entry.table === "interviews")).toHaveLength(0);
  });

  it("never matches the candidate's own domain to a company", async () => {
    const { client, recorded } = makeClient();
    const result = await syncOneCalendarConnection(
      client,
      connection({ email_address: "hr@acme.test" }),
      CONFIG,
      KEY,
      calendarFetch([interviewEvent({ summary: "Focus time" })]),
    );

    expect(result.created).toBe(0);
    expect(recorded.inserts.filter((entry) => entry.table === "interviews")).toHaveLength(0);
  });

  it("links by company name in the event text when no domain matches", async () => {
    const { client, recorded } = makeClient();
    const result = await syncOneCalendarConnection(
      client,
      connection(),
      CONFIG,
      KEY,
      calendarFetch([
        interviewEvent({
          summary: "Interview with Acme Corporation",
          organizer: { email: "agency@recruiter.test" },
          attendees: [{ email: "candidate@personal.test", self: true }],
        }),
      ]),
    );

    expect(result.created).toBe(1);
    expect(recorded.inserts.find((entry) => entry.table === "interviews")!.payload).toMatchObject({
      application_attempt_id: APPLICATION.attemptId,
    });
  });

  it("skips an all-day event rather than storing a slot with no time", async () => {
    const { client, recorded } = makeClient();
    const result = await syncOneCalendarConnection(
      client,
      connection(),
      CONFIG,
      KEY,
      calendarFetch([interviewEvent({ start: { date: "2026-09-25" }, end: { date: "2026-09-26" } })]),
    );

    expect(result.created).toBe(0);
    expect(result.skippedUnlinked).toBe(1);
    expect(recorded.inserts.filter((entry) => entry.table === "interviews")).toHaveLength(0);
  });
});

describe("syncOneCalendarConnection — change, reschedule and cancellation", () => {
  const existing = {
    id: "interview-1",
    application_attempt_id: APPLICATION.attemptId,
    status: "invited",
    scheduled_at: "2026-09-25T08:30:00.000Z",
    timezone: "Asia/Kolkata",
    duration_minutes: 60,
    meeting_url: null,
    dial_in: null,
    location: null,
    instructions: null,
    interviewers: null,
    recruiter_name: null,
    external_updated_at: "2026-09-20T10:00:00.000Z",
  };

  it("records a reschedule when the start time moves", async () => {
    const { client, recorded } = makeClient({ existingInterview: existing });
    const result = await syncOneCalendarConnection(
      client,
      connection(),
      CONFIG,
      KEY,
      calendarFetch([interviewEvent({ updated: "2026-09-21T09:00:00.000Z", start: { dateTime: "2026-09-26T14:00:00+05:30", timeZone: "Asia/Kolkata" }, end: { dateTime: "2026-09-26T15:00:00+05:30", timeZone: "Asia/Kolkata" } })]),
    );

    expect(result.rescheduled).toBe(1);
    const change = recorded.inserts.find((entry) => entry.table === "interview_event_changes")!;
    expect(change.payload.change_type).toBe("rescheduled");
    expect(recorded.updates.find((entry) => entry.table === "interviews")!.payload).toMatchObject({ status: "rescheduled" });
  });

  it("records an update, not a reschedule, when only the meeting link changes", async () => {
    const { client, recorded } = makeClient({ existingInterview: existing });
    const result = await syncOneCalendarConnection(
      client,
      connection(),
      CONFIG,
      KEY,
      calendarFetch([interviewEvent({ updated: "2026-09-21T09:00:00.000Z", hangoutLink: "https://meet.test/abc" })]),
    );

    expect(result.updated).toBe(1);
    expect(result.rescheduled).toBe(0);
    expect(recorded.inserts.find((entry) => entry.table === "interview_event_changes")!.payload.change_type).toBe("updated");
  });

  it("marks a cancelled event cancelled and records the change", async () => {
    const { client, recorded } = makeClient({ existingInterview: existing });
    const result = await syncOneCalendarConnection(
      client,
      connection(),
      CONFIG,
      KEY,
      calendarFetch([interviewEvent({ status: "cancelled", updated: "2026-09-22T09:00:00.000Z" })]),
    );

    expect(result.cancelled).toBe(1);
    expect(recorded.updates.find((entry) => entry.table === "interviews")!.payload).toMatchObject({ status: "cancelled" });
    expect(recorded.inserts.find((entry) => entry.table === "interview_event_changes")!.payload).toMatchObject({
      change_type: "cancelled",
    });
  });

  it("NEVER writes to the application when an interview is cancelled (RI PRD §13.3)", async () => {
    const { client, recorded } = makeClient({ existingInterview: existing });

    await syncOneCalendarConnection(
      client,
      connection(),
      CONFIG,
      KEY,
      calendarFetch([interviewEvent({ status: "cancelled", updated: "2026-09-22T09:00:00.000Z" })]),
    );

    const touched = [...recorded.inserts, ...recorded.updates].map((entry) => entry.table);
    expect(touched).not.toContain("application_attempts");
    expect(touched).not.toContain("application_plans");
    expect(touched).not.toContain("vacancies");
  });

  it("writes nothing for an event whose updated timestamp has not moved", async () => {
    const { client, recorded } = makeClient({ existingInterview: existing });
    const result = await syncOneCalendarConnection(
      client,
      connection(),
      CONFIG,
      KEY,
      calendarFetch([interviewEvent({ updated: existing.external_updated_at })]),
    );

    expect(result.unchanged).toBe(1);
    expect(recorded.inserts.filter((entry) => entry.table === "interview_event_changes")).toHaveLength(0);
  });

  it("ignores a cancellation for an event it never stored", async () => {
    const { client, recorded } = makeClient({ existingInterview: null });
    const result = await syncOneCalendarConnection(
      client,
      connection(),
      CONFIG,
      KEY,
      calendarFetch([interviewEvent({ status: "cancelled" })]),
    );

    expect(result.cancelled).toBe(0);
    expect(result.skippedUnlinked).toBe(1);
    expect(recorded.inserts).toHaveLength(0);
  });
});

describe("syncOneCalendarConnection — sync token handling", () => {
  it("stores the token returned by the final page", async () => {
    const { client, recorded } = makeClient();
    await syncOneCalendarConnection(client, connection(), CONFIG, KEY, calendarFetch([], "sync-final"));

    const update = recorded.updates.find((entry) => entry.table === "mailbox_connections")!;
    expect(update.payload.calendar_sync_token).toBe("sync-final");
    expect(update.payload.calendar_sync_failure_count).toBe(0);
    expect(update.payload.calendar_last_sync_error).toBeNull();
  });

  it("does a bounded full resync when Google answers 410 and clears the dead token", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      // First call carries the stale token and fails; the second is the resync.
      if (String(url).includes("syncToken=")) {
        return { ok: false, status: 410, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ items: [], nextSyncToken: "sync-fresh" }) };
    }) as unknown as typeof fetch;

    const { client, recorded } = makeClient({ syncToken: "stale-token" });
    const result = await syncOneCalendarConnection(client, connection({ calendar_sync_token: "stale-token" }), CONFIG, KEY, fetchImpl);

    expect(result.resynced).toBe(true);
    expect(result.outcome).toBe("success");

    const urls = (fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("syncToken=stale-token"))).toBe(true);
    // The resync must bound the window rather than pulling all of history.
    expect(urls.some((url) => url.includes("timeMin="))).toBe(true);

    expect(recorded.updates.find((entry) => entry.table === "mailbox_connections")!.payload.calendar_sync_token).toBe("sync-fresh");
  });

  it("reports a transient failure without parking the connection until the ceiling", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const { client, recorded } = makeClient({ failureCount: 0 });

    const result = await syncOneCalendarConnection(client, connection({ calendar_sync_failure_count: 0 }), CONFIG, KEY, fetchImpl);

    expect(result.outcome).toBe("transient_error");
    const update = recorded.updates.find((entry) => entry.table === "mailbox_connections")!;
    expect(update.payload.calendar_sync_failure_count).toBe(1);
    expect(update.payload.status).toBeUndefined();
  });

  it("parks the connection at the failure ceiling", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const { client, recorded } = makeClient();

    const result = await syncOneCalendarConnection(client, connection({ calendar_sync_failure_count: 4 }), CONFIG, KEY, fetchImpl);

    expect(result.outcome).toBe("transient_error");
    expect(recorded.updates.find((entry) => entry.table === "mailbox_connections")!.payload.status).toBe("error");
  });

  it("refreshes an expired access token before calling Google", async () => {
    const expiredBundle = encryptMailboxSecret(
      KEY,
      JSON.stringify({ accessToken: "old", refreshToken: "refresh-token", expiresAt: Date.now() - 1000 }),
    );

    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "new", expires_in: 3600, scope: "s" }) };
      }
      return { ok: true, status: 200, json: async () => ({ items: [], nextSyncToken: "sync-2" }) };
    }) as unknown as typeof fetch;

    const { client, recorded } = makeClient();
    const result = await syncOneCalendarConnection(
      client,
      connection({ secret_manager_key: expiredBundle }),
      CONFIG,
      KEY,
      fetchImpl,
    );

    expect(result.outcome).toBe("success");
    const urls = (fetchImpl as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("oauth2.googleapis.com/token"))).toBe(true);
    // The refreshed bundle is persisted so the next run does not refresh again.
    expect(recorded.updates.some((entry) => entry.table === "mailbox_connections" && "secret_manager_key" in entry.payload)).toBe(true);
  });
});
