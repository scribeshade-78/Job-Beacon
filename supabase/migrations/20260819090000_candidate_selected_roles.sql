-- Minimal role taxonomy foundation (R4.5; PRD §9.1 role selection,
-- referenced but deferred by both the automation_authorizations migration
-- comment and eligibilityGate.ts's role_match hard-block placeholder).
--
-- No normalized role taxonomy exists anywhere in this repository yet —
-- this is deliberately just a candidate-authored list of free-text role
-- names, matched against vacancies.raw_title by simple substring
-- comparison in eligibilityGate.ts. role_name carries no CHECK-constrained
-- enumeration (unlike candidate_exclusions.category) because there is no
-- fixed set of values to enumerate yet; a normalized taxonomy is later
-- scope, not this migration's job.
--
-- Unlike candidate_exclusions (a toggle set with composite primary key and
-- no UPDATE grant), this table needs UPDATE — a candidate correcting a
-- typo in a selected role name is an edit, not a delete-and-reinsert — so
-- it takes a surrogate id primary key instead, the same shape as
-- application_plans.
create table public.candidate_selected_roles (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,
  role_name text not null,

  created_at timestamptz not null default now(),

  unique (candidate_id, role_name)
);

create index candidate_selected_roles_candidate_id_idx on public.candidate_selected_roles (candidate_id);

alter table public.candidate_selected_roles enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.candidate_selected_roles from public;
revoke all on public.candidate_selected_roles from anon;
revoke all on public.candidate_selected_roles from authenticated;

-- Full CRUD for the owning candidate — this is a candidate-authored,
-- candidate-editable preference (the automation_authorizations /
-- candidate_exclusions precedent), not system-generated output like
-- application_plans/application_attempts.
grant select, insert, update, delete on public.candidate_selected_roles to authenticated;
grant select, insert, update, delete on public.candidate_selected_roles to service_role;

create policy "candidate_selected_roles_select_own"
  on public.candidate_selected_roles
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);

create policy "candidate_selected_roles_insert_own"
  on public.candidate_selected_roles
  for insert
  to authenticated
  with check ((select auth.uid()) = candidate_id);

create policy "candidate_selected_roles_update_own"
  on public.candidate_selected_roles
  for update
  to authenticated
  using ((select auth.uid()) = candidate_id)
  with check ((select auth.uid()) = candidate_id);

create policy "candidate_selected_roles_delete_own"
  on public.candidate_selected_roles
  for delete
  to authenticated
  using ((select auth.uid()) = candidate_id);
