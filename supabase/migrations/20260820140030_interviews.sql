-- Interview detection (R6.1; PRD §21.1 Responses domain, §22.2
-- "interview.detected.v1"). Schema and RLS only — no detection logic
-- exists anywhere in this repository yet.
--
-- message_id is not null: in this design an interview is always
-- detected FROM a classified message, not manually logged by a
-- candidate (the PRD names no candidate-authored interview-logging
-- flow). application_attempt_id is nullable for the same "matching is
-- unsolved" reason as messages.application_attempt_id. format carries
-- no enumeration — the PRD does not name interview format values
-- (phone/video/onsite etc.). raw_payload is generic JSONB, same
-- "no invented shape" precedent as messages.raw_payload.
--
-- No direct candidate_id column: ownership is transitive through
-- messages -> mailbox_connections.candidate_id, same shape as
-- response_classifications.
create table public.interviews (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  application_attempt_id uuid references public.application_attempts (id),

  scheduled_at timestamptz,
  format text,

  raw_payload jsonb,

  created_at timestamptz not null default now()
);

create index interviews_message_id_idx on public.interviews (message_id);
create index interviews_application_attempt_id_idx on public.interviews (application_attempt_id);

alter table public.interviews enable row level security;

revoke all on public.interviews from public;
revoke all on public.interviews from anon;
revoke all on public.interviews from authenticated;

grant select on public.interviews to authenticated;
grant select, insert, update, delete on public.interviews to service_role;

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
  );
