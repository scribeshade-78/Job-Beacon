-- Global exclusions / hard constraints (PRD 9.2, 21.1). Categories are the
-- ones PRD 31 names explicitly ("staffing agencies, contract roles,
-- relocation ... and sensitive sectors"). Salary is deliberately NOT
-- included here: PRD 31 lists it alongside these categories but never
-- defines the mechanism (e.g. a numeric floor) the way it defines these as
-- plain category toggles, and no other section of the PRD specifies that
-- field shape either — inventing one would be inventing a requirement.
--
-- A row present means the candidate has turned that exclusion on; no row
-- means off. PRD 31 leaves "default exclusions" as an explicit
-- founder-choice-required open decision, so nothing is pre-populated —
-- every candidate starts with zero exclusions until they opt in.
create table public.candidate_exclusions (
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,
  category text not null check (
    category in (
      'staffing_agencies',
      'contract_roles',
      'relocation_required',
      'sensitive_sectors'
    )
  ),
  created_at timestamptz not null default now(),
  primary key (candidate_id, category)
);

alter table public.candidate_exclusions enable row level security;

revoke all on public.candidate_exclusions from public;
revoke all on public.candidate_exclusions from anon;
revoke all on public.candidate_exclusions from authenticated;

grant select, insert, delete on public.candidate_exclusions to authenticated;

create policy "candidate_exclusions_select_own"
  on public.candidate_exclusions
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);

create policy "candidate_exclusions_insert_own"
  on public.candidate_exclusions
  for insert
  to authenticated
  with check ((select auth.uid()) = candidate_id);

create policy "candidate_exclusions_delete_own"
  on public.candidate_exclusions
  for delete
  to authenticated
  using ((select auth.uid()) = candidate_id);
