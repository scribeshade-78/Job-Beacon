-- Task H2: mailbox automation and Google Calendar interview tracking.
--
-- Requirements traced to the Response Intelligence PRD, quoted where it matters:
--   FR-012  "Connect calendar and detect interview creation, change, reschedule
--           and cancellation."
--   §13.1   the Interview Record field groups: Identity, Schedule, Access,
--           Preparation, Lifecycle, Evidence.
--   §13.3   "Retain the original event in audit history while the current
--           schedule becomes authoritative."
--   §7.1    "Calendar watch / incremental sync ... Refresh event details and
--           retain old event in audit history."
--   §7.2    "Calendar health: Active channel and recent sync / Channel near
--           expiry / Events unavailable or permission revoked."
--
-- THE CALENDAR LIVES ON THE MAILBOX CONNECTION, NOT BESIDE IT. The PRD's own data
-- model (§15) has one MailboxConnection carrying "provider, account, scopes,
-- tokens, watch expiry, last history ID, sync health", and one Gmail account
-- authorises mail and calendar together. A second calendar_connections table
-- would mean two rows for one Google account, two tokens to keep in step, and a
-- "which one is authoritative" question with no answer. So the calendar's sync
-- state is added to mailbox_connections as a second channel on the same row.
--
-- WHAT THIS FILE DOES NOT DO. It does not request the calendar scope — that is a
-- change to the OAuth authorize URL and lives in server/mailbox/oauth.ts. It
-- does not fabricate preparation content: §13.1's Preparation group is authored
-- material (likely questions, STAR stories), so this adds only the column a
-- person can write notes into and says so below.

-- ---------------------------------------------------------------------------
-- 1. The calendar channel, on the existing connection row.
--
-- Every column answers a specific §7.1/§7.2 requirement rather than anticipating
-- one. calendar_sync_token IS the incremental cursor ("incremental sync");
-- channel id/resource/expiry IS the watch (§7.1 "Calendar watch", §7.2 "Channel
-- near expiry"); last_synced_at and last_sync_error ARE the sync-health
-- indicator ("Active channel and recent sync" / "Events unavailable or
-- permission revoked").
--
-- A Gmail-only connection keeps all of these NULL. The sync loop decides what to
-- do by reading granted_scopes, not by assuming this file ran.
-- ---------------------------------------------------------------------------
alter table public.mailbox_connections
  add column if not exists calendar_sync_token text,
  add column if not exists calendar_channel_id text,
  add column if not exists calendar_resource_id text,
  add column if not exists calendar_channel_expiry timestamptz,
  add column if not exists calendar_last_synced_at timestamptz,
  add column if not exists calendar_last_sync_error text,
  add column if not exists calendar_sync_failure_count integer not null default 0,
  add column if not exists calendar_leased_until timestamptz;

comment on column public.mailbox_connections.calendar_sync_token is
  'Google Calendar nextSyncToken. The incremental cursor: events.list with this token returns only what changed since. Cleared on a 410 Gone so the next run does a bounded full resync (RI PRD §7.1 fallback). NULL means no sync has completed yet.';

comment on column public.mailbox_connections.calendar_channel_expiry is
  'When the Google Calendar watch channel stops delivering. RI PRD §7.2 calls a channel approaching this "warning" and a channel past it "critical", which is why the exact instant is stored rather than a boolean.';

-- Separate lease from polling_leased_until: a mail poll and a calendar sync are
-- independent jobs over the same credential and must not block each other.
create index mailbox_connections_calendar_due_idx
  on public.mailbox_connections (calendar_leased_until)
  where status = 'connected';

-- ---------------------------------------------------------------------------
-- 2. Interviews, aligned with §13.1's field groups.
--
-- The table already existed with five meaningful columns (message_id,
-- application_attempt_id, scheduled_at, format, raw_payload) and ZERO rows, so
-- this is a straight extension with no backfill to reason about.
--
-- "Asia/Kolkata conversion" from §13.1 is deliberately NOT stored. It is a pure
-- function of scheduled_at plus timezone, and a stored copy is a second answer
-- to the same question that goes stale the moment either input changes or the
-- tz database is updated. It is computed for display instead. That is a
-- deviation from a literal field list and is called out rather than hidden.
-- ---------------------------------------------------------------------------
alter table public.interviews
  add column if not exists source text not null default 'email',
  add column if not exists status text not null default 'invited',

  -- Identity (§13.1). Company and role are NOT columns here: they belong to the
  -- application this interview is for, and duplicating them would create a
  -- second copy that can disagree with the vacancy record.
  add column if not exists round text,
  add column if not exists interviewers text[],
  add column if not exists recruiter_name text,

  -- Schedule (§13.1).
  add column if not exists timezone text,
  add column if not exists duration_minutes integer,
  add column if not exists calendar_event_id text,
  add column if not exists calendar_connection_id uuid references public.mailbox_connections (id) on delete set null,
  add column if not exists external_updated_at timestamptz,

  -- Access (§13.1).
  add column if not exists meeting_url text,
  add column if not exists dial_in text,
  add column if not exists location text,
  add column if not exists instructions text,
  add column if not exists backup_contact text,

  -- Preparation (§13.1) — the ONE column a human fills in. The generated half of
  -- this field group (likely questions, STAR stories, company notes) is authored
  -- content with its own quality bar, and inventing storage for generators that
  -- do not exist would make the schema claim a capability the product lacks.
  add column if not exists preparation_notes text,

  add column if not exists last_synced_at timestamptz;

alter table public.interviews
  add constraint interviews_source_check check (source in ('email', 'calendar', 'manual')),
  -- §13.1 Lifecycle, verbatim: "Invited, accepted, rescheduled, cancelled,
  -- completed, follow-up sent and result pending".
  add constraint interviews_status_check check (
    status in ('invited', 'accepted', 'rescheduled', 'cancelled', 'completed', 'follow_up_sent', 'result_pending')
  ),
  add constraint interviews_duration_check check (duration_minutes is null or duration_minutes > 0);

comment on column public.interviews.status is
  'RI PRD §13.1 Lifecycle, exactly as the PRD lists it. "cancelled" here means the interview was called off — §13.3 is explicit that a cancelled interview event must NEVER be read as a rejection, so nothing in the application pipeline may derive a rejection from this value.';

comment on column public.interviews.timezone is
  'The ORIGINAL event time zone, per §13.1 "Original date/time/time zone". The Asia/Kolkata conversion the same bullet asks for is derived at read time rather than stored, so the two can never disagree.';

-- One calendar event maps to one interview. Partial, because an email-sourced
-- interview has no calendar event id and many NULLs must not collide.
create unique index interviews_calendar_event_idx
  on public.interviews (calendar_connection_id, calendar_event_id)
  where calendar_event_id is not null;

create index interviews_status_scheduled_idx on public.interviews (status, scheduled_at);

-- ---------------------------------------------------------------------------
-- 3. The change history §13.3 and §7.1 require.
--
-- "Retain the original event in audit history while the current schedule becomes
-- authoritative" is only satisfiable if the previous values are kept somewhere.
-- This table is that somewhere: every detected change writes the before and the
-- after, so the interviews row can always hold the current truth while the
-- history holds every truth it has had.
--
-- APPEND-ONLY BY GRANT, not by convention: service_role gets insert and select
-- and nothing else, so no code path can rewrite a detected change. That matters
-- because this is the evidence a candidate would use to prove an interview was
-- moved.
-- ---------------------------------------------------------------------------
create table public.interview_event_changes (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references public.interviews (id) on delete cascade,

  change_type text not null,
  source text not null,
  /** One human-readable line, so the history is legible without diffing jsonb. */
  summary text not null,

  previous_values jsonb,
  new_values jsonb,

  detected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  check (change_type in ('created', 'rescheduled', 'cancelled', 'updated', 'restored')),
  check (source in ('calendar', 'email', 'manual'))
);

create index interview_event_changes_interview_idx
  on public.interview_event_changes (interview_id, detected_at desc);

alter table public.interview_event_changes enable row level security;

revoke all on public.interview_event_changes from public, anon, authenticated;
grant select on public.interview_event_changes to authenticated;
-- No update/delete, deliberately. See the table comment.
grant select, insert on public.interview_event_changes to service_role;

-- Ownership follows the interview, which itself follows either its message or
-- its application. Written as one EXISTS with the same two-hop shape
-- follow_up_drafts uses, so the new table cannot drift from its parent.
create policy "interview_event_changes_select_own"
  on public.interview_event_changes
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.interviews i
      left join public.messages m on m.id = i.message_id
      left join public.mailbox_connections mc on mc.id = m.mailbox_connection_id
      left join public.application_attempts a on a.id = i.application_attempt_id
      left join public.application_plans p on p.id = a.application_plan_id
      where i.id = interview_event_changes.interview_id
        and (mc.candidate_id = (select auth.uid()) or p.candidate_id = (select auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Widening the interviews read policy to cover calendar-sourced rows.
--
-- The existing policy reaches ownership only through messages -> mailbox
-- connections. A calendar interview has no message, so under that policy it
-- would be invisible to the candidate it belongs to — the interview would be
-- tracked and never shown, which is worse than not tracking it. The policy is
-- replaced with the same check OR the application path.
-- ---------------------------------------------------------------------------
drop policy if exists "interviews_select_own" on public.interviews;

create policy "interviews_select_own"
  on public.interviews
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.messages m
      join public.mailbox_connections mc on mc.id = m.mailbox_connection_id
      where m.id = interviews.message_id
        and mc.candidate_id = (select auth.uid())
    )
    or exists (
      select 1
      from public.application_attempts a
      join public.application_plans p on p.id = a.application_plan_id
      where a.id = interviews.application_attempt_id
        and p.candidate_id = (select auth.uid())
    )
  );
