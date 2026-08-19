-- Response classification (R6.1; PRD §21.1 Responses domain, §24.1
-- "Permitted AI use: ... Response classification"). Schema and RLS
-- only — no classifier exists anywhere in this repository yet.
--
-- category carries no CHECK-constrained enumeration: unlike
-- mailbox_connections.provider, the PRD names "response classification"
-- as a capability but never enumerates the actual category values
-- (rejection, interview invite, recruiter follow-up, etc.) — same "no
-- taxonomy invented until a real requirement defines one" precedent as
-- extracted_facts.fact_type. model_version is a real, explicit PRD
-- requirement (§22.3 "Model and prompt version where AI is involved"),
-- not a guess — same precedent as resumeGenerator.ts's
-- templateVersion/modelVersion.
--
-- No direct candidate_id column: ownership is transitive through
-- messages -> mailbox_connections.candidate_id, two joins deep, same
-- shape as action_required_events -> application_attempts ->
-- application_plans.candidate_id.
create table public.response_classifications (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,

  category text not null,
  confidence numeric,
  model_version text not null,

  classified_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index response_classifications_message_id_idx on public.response_classifications (message_id);

alter table public.response_classifications enable row level security;

revoke all on public.response_classifications from public;
revoke all on public.response_classifications from anon;
revoke all on public.response_classifications from authenticated;

grant select on public.response_classifications to authenticated;
grant select, insert, update, delete on public.response_classifications to service_role;

create policy "response_classifications_select_own"
  on public.response_classifications
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.messages m
      join public.mailbox_connections mc on mc.id = m.mailbox_connection_id
      where m.id = response_classifications.message_id
        and mc.candidate_id = (select auth.uid())
    )
  );
