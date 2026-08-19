-- Mailbox message metadata (R6.1; PRD §21.1 Responses domain). Schema
-- and RLS only — no ingestion pipeline exists yet to populate this
-- table (that needs the OAuth connection this repository doesn't have).
--
-- raw_payload is deliberately generic JSONB, same "no invented shape"
-- precedent as vacancy_evidence.payload and action_required_events.payload:
-- what a real Gmail/Outlook message fetch actually returns, and what
-- subset is safe/necessary to retain, is a real product and privacy
-- decision this migration should not preempt by inventing typed columns
-- (a body/content column in particular) for a retention policy that
-- doesn't exist yet. Only the minimal metadata needed to reference and
-- deduplicate a message is a named column.
--
-- application_attempt_id is nullable: "application matching" (§23) —
-- tying an inbound message to the specific application it responds to —
-- is itself unsolved matching logic, the same class of gap as R5.6/R5.7's
-- CIN discovery. A message can be captured before matching happens;
-- this column is populated once that logic exists, not by this
-- migration.
--
-- No direct candidate_id column: ownership is transitive through
-- mailbox_connections.candidate_id, the same "no direct candidate_id,
-- transitively owned" shape as application_attempts/application_evidence.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  mailbox_connection_id uuid not null references public.mailbox_connections (id) on delete cascade,
  application_attempt_id uuid references public.application_attempts (id),

  provider_message_id text not null,
  sender text,
  subject text,
  received_at timestamptz,

  raw_payload jsonb,

  created_at timestamptz not null default now(),

  unique (mailbox_connection_id, provider_message_id)
);

create index messages_mailbox_connection_id_idx on public.messages (mailbox_connection_id);
create index messages_application_attempt_id_idx on public.messages (application_attempt_id);

alter table public.messages enable row level security;

revoke all on public.messages from public;
revoke all on public.messages from anon;
revoke all on public.messages from authenticated;

grant select on public.messages to authenticated;
grant select, insert, update, delete on public.messages to service_role;

create policy "messages_select_own"
  on public.messages
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.mailbox_connections mc
      where mc.id = messages.mailbox_connection_id
        and mc.candidate_id = (select auth.uid())
    )
  );
