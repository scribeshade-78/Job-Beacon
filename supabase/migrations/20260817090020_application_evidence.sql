-- Submission evidence per attempt (R4.1; PRD §16.4 "Capture confirmation,
-- timestamps, screenshots/receipts where permitted", §21.1 Applications
-- domain). Schema and RLS only — no submission logic exists yet to
-- populate this table (that's R4.3+); this migration exists to have the
-- table and boundaries verified first.
--
-- Deliberately generic, same precedent as R3.1's vacancy_evidence.payload:
-- no concrete submission-capture logic exists yet, so payload is JSONB
-- rather than this migration inventing specific typed columns (receipt
-- URL, confirmation ID, screenshot path, etc.) for evidence shapes that
-- don't exist in code yet.
create table public.application_evidence (
  id uuid primary key default gen_random_uuid(),
  application_attempt_id uuid not null references public.application_attempts (id),

  evidence_type text not null,
  payload jsonb not null,

  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index application_evidence_application_attempt_id_idx on public.application_evidence (application_attempt_id);

alter table public.application_evidence enable row level security;

revoke all on public.application_evidence from public;
revoke all on public.application_evidence from anon;
revoke all on public.application_evidence from authenticated;

-- Candidate-facing read surface (PRD §18.2 "Recent applications and
-- evidence"), transitively owned through application_attempts ->
-- application_plans.candidate_id — two joins deep, since this table has
-- no direct candidate_id column. No mutation grant for authenticated;
-- evidence is captured only by the (not-yet-built) submission worker.
grant select on public.application_evidence to authenticated;
grant select, insert, update, delete on public.application_evidence to service_role;

create policy "application_evidence_select_own"
  on public.application_evidence
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.application_attempts aa
      join public.application_plans ap on ap.id = aa.application_plan_id
      where aa.id = application_evidence.application_attempt_id
        and ap.candidate_id = (select auth.uid())
    )
  );
