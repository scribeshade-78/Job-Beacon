-- Automation authorization + pause/resume/stop (PRD 9.2, 21.1, 2.3).
-- Role-specific scoping is deliberately NOT modeled here: candidate_selected_roles
-- doesn't exist yet (role suggestion/search are out of scope for this pass —
-- see the R1 completion report), and PRD 31 explicitly leaves "whether
-- one-time authorization is role-specific or global" as a founder decision.
-- This is whole-account scope, the smaller of the two options and the one
-- that doesn't foreclose adding role-specific scoping additively later.
--
-- No row means "not yet authorized". A row's status tracks
-- authorized/paused/stopped once the candidate has given first consent.
create table public.automation_authorizations (
  candidate_id uuid primary key references public.candidate_profiles (id) on delete cascade,
  status text not null check (status in ('authorized', 'paused', 'stopped')),
  consent_version text not null,
  created_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now()
);

alter table public.automation_authorizations enable row level security;

revoke all on public.automation_authorizations from public;
revoke all on public.automation_authorizations from anon;
revoke all on public.automation_authorizations from authenticated;

-- No DELETE: PRD 21.2's "decisions aren't deleted, corrections create new
-- versions" principle applies here by analogy — authorization history is an
-- audit trail (status transitions), not a mutable preference to be erased.
-- Candidate-initiated account/data deletion is handled by the
-- candidate_profiles cascade, not a direct delete on this table.
grant select, insert, update on public.automation_authorizations to authenticated;

create policy "automation_authorizations_select_own"
  on public.automation_authorizations
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);

create policy "automation_authorizations_insert_own"
  on public.automation_authorizations
  for insert
  to authenticated
  with check ((select auth.uid()) = candidate_id);

create policy "automation_authorizations_update_own"
  on public.automation_authorizations
  for update
  to authenticated
  using ((select auth.uid()) = candidate_id)
  with check ((select auth.uid()) = candidate_id);
