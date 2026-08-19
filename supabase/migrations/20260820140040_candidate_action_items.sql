-- Candidate action items derived from mailbox responses (R6.1; PRD
-- §21.1 Responses domain). Schema and RLS only — no generation logic
-- exists anywhere in this repository yet.
--
-- Distinct from action_required_events (R4.1): that table is PRD §17's
-- seven named submission-time exceptions pausing an application
-- attempt mid-flight. This table is post-response follow-up work
-- (confirm an interview time, reply to a recruiter question) surfaced
-- from a classified mailbox message — a different trigger, a different
-- domain, not a duplicate concept.
--
-- item_type carries no enumeration — the PRD names no fixed taxonomy of
-- action item types, same "no taxonomy invented" precedent as
-- response_classifications.category. status is a minimal, real
-- lifecycle (pending -> completed/dismissed), not a guess at business
-- rules beyond "has the candidate dealt with this or not".
--
-- No direct candidate_id column: ownership is transitive through
-- messages -> mailbox_connections.candidate_id, same shape as
-- response_classifications/interviews.
create table public.candidate_action_items (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,

  item_type text not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'dismissed')),
  due_at timestamptz,

  raw_payload jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index candidate_action_items_message_id_idx on public.candidate_action_items (message_id);

alter table public.candidate_action_items enable row level security;

revoke all on public.candidate_action_items from public;
revoke all on public.candidate_action_items from anon;
revoke all on public.candidate_action_items from authenticated;

grant select on public.candidate_action_items to authenticated;
grant select, insert, update, delete on public.candidate_action_items to service_role;

create policy "candidate_action_items_select_own"
  on public.candidate_action_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.messages m
      join public.mailbox_connections mc on mc.id = m.mailbox_connection_id
      where m.id = candidate_action_items.message_id
        and mc.candidate_id = (select auth.uid())
    )
  );
