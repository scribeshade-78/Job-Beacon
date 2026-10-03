-- Candidate-owned per-vacancy decisions: Save and Dismiss.
--
-- WHY TWO TABLES RATHER THAN A `decision` COLUMN ON ONE. Save and Dismiss are
-- not mutually exclusive states and must not be collapsed into one enum: a
-- candidate can dismiss a job they had saved (the interesting case), and they
-- can save something they had previously dismissed (changed their mind). One
-- row per (candidate, vacancy) per table keeps both facts independently
-- reversible — an undo restores exactly the prior state instead of destroying
-- the other one.
--
-- PRECEDENCE IS DEFINED AT READ TIME, NOT BY A WRITE CASCADE: DISMISSAL WINS.
-- A vacancy that is both saved and dismissed is excluded from the feed and from
-- every eligibility/automation path until the dismissal is undone. This is why
-- dismissing deliberately does NOT delete the saved row: "undo dismiss" then
-- restores the candidate's saved job rather than silently losing it, and a
-- dismissed-then-saved vacancy still cannot reach an automatic queue.
--
-- WHY NOT candidate_exclusions. That table (20260813184939) is a set of global
-- PRD §31 CATEGORIES (staffing agencies, contract roles, ...) and has no
-- vacancy dimension at all. Folding a per-listing decision into it would make
-- every reader special-case a category that is not a category.
--
-- WHAT IS NOT HERE. Nothing deletes or mutates a vacancy, an application_plan
-- or an application_attempt. Dismissal is a read-time filter over candidate-owned
-- state, so already-submitted application history is preserved by construction
-- (a future migration must not "clean up" dismissed plans for that reason).
--
-- SERVICE-ROLE ACCESS IS NOT PROTECTED BY RLS. Every backend read of these
-- tables MUST scope by candidate_id explicitly; there is no policy that will
-- do it for a service-role client. The dismissal gate
-- (server/applications/dismissalGate.ts) is written that way on purpose.
create table public.saved_vacancies (
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,
  vacancy_id uuid not null references public.vacancies (id) on delete cascade,
  saved_at timestamptz not null default now(),
  primary key (candidate_id, vacancy_id)
);

-- One reason vocabulary, CHECK-constrained, so the stored value is always
-- renderable rather than a free-text field every reader has to interpret.
-- 'other' is the escape hatch; `note` is the optional free text beside it.
create table public.dismissed_vacancies (
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,
  vacancy_id uuid not null references public.vacancies (id) on delete cascade,
  reason text not null check (
    reason in (
      'not_interested',
      'wrong_role',
      'wrong_location',
      'wrong_seniority',
      'company',
      'other'
    )
  ),
  note text,
  dismissed_at timestamptz not null default now(),
  primary key (candidate_id, vacancy_id)
);

-- The feed exclusion reads "every vacancy this candidate dismissed", so the
-- candidate's own rows are the lookup; the primary key already serves the
-- (candidate_id, vacancy_id) probe the gates make.
create index dismissed_vacancies_candidate_id_idx on public.dismissed_vacancies (candidate_id);
create index saved_vacancies_candidate_id_idx on public.saved_vacancies (candidate_id);

alter table public.saved_vacancies enable row level security;
alter table public.dismissed_vacancies enable row level security;

-- Same defense-in-depth ordering as every prior migration: strip what
-- Supabase's base template pre-grants (TRUNCATE bypasses RLS entirely), then
-- grant back only what this slice needs.
revoke all on public.saved_vacancies from public;
revoke all on public.saved_vacancies from anon;
revoke all on public.saved_vacancies from authenticated;

revoke all on public.dismissed_vacancies from public;
revoke all on public.dismissed_vacancies from anon;
revoke all on public.dismissed_vacancies from authenticated;

-- Select/insert/delete only. There is no UPDATE grant and no update policy:
-- undo is a DELETE (reversible), and the recorded reason of an existing
-- dismissal is evidence rather than an editable field — the same immutability
-- discipline vacancy_reports applies to a submitted report.
grant select, insert, delete on public.saved_vacancies to authenticated;
grant select, insert, delete on public.dismissed_vacancies to authenticated;

grant select, insert, update, delete on public.saved_vacancies to service_role;
grant select, insert, update, delete on public.dismissed_vacancies to service_role;

create policy "saved_vacancies_select_own"
  on public.saved_vacancies
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);

create policy "saved_vacancies_insert_own"
  on public.saved_vacancies
  for insert
  to authenticated
  with check ((select auth.uid()) = candidate_id);

create policy "saved_vacancies_delete_own"
  on public.saved_vacancies
  for delete
  to authenticated
  using ((select auth.uid()) = candidate_id);

create policy "dismissed_vacancies_select_own"
  on public.dismissed_vacancies
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);

create policy "dismissed_vacancies_insert_own"
  on public.dismissed_vacancies
  for insert
  to authenticated
  with check ((select auth.uid()) = candidate_id);

create policy "dismissed_vacancies_delete_own"
  on public.dismissed_vacancies
  for delete
  to authenticated
  using ((select auth.uid()) = candidate_id);

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — run after applying, none executed here.
--
-- 1. Both tables exist with RLS on:
--      select relname, relrowsecurity from pg_class
--      where oid in ('public.saved_vacancies'::regclass, 'public.dismissed_vacancies'::regclass);
--      -- expect two rows, relrowsecurity = true
--
-- 2. authenticated holds exactly select/insert/delete and no update:
--      select table_name, privilege_type from information_schema.table_privileges
--      where grantee = 'authenticated'
--        and table_name in ('saved_vacancies','dismissed_vacancies')
--      order by 1,2;
--      -- expect 6 rows: 3 per table, no UPDATE
--
-- 3. Exactly three own-row policies per table:
--      select tablename, policyname, cmd from pg_policies
--      where tablename in ('saved_vacancies','dismissed_vacancies') order by 1,3;
--
-- 4. Cross-candidate isolation (as candidate B with candidate A's rows present):
--      set local role authenticated;
--      set local request.jwt.claims = '{"sub":"<candidate-B-uuid>"}';
--      select count(*) from public.saved_vacancies;          -- expect only B's rows
--      insert into public.saved_vacancies (candidate_id, vacancy_id)
--        values ('<candidate-A-uuid>', '<any-vacancy>');     -- expect 42501
--
-- 5. Dismissal wins over save (the precedence rule, exercised without a queue):
--      select s.candidate_id, s.vacancy_id
--      from public.saved_vacancies s
--      join public.dismissed_vacancies d using (candidate_id, vacancy_id);
--      -- every returned pair MUST be excluded from the feed and from eligibility
--
-- ROLLBACK / RECOVERY
--   Dropping both tables removes only candidate decisions; no vacancy,
--   application_plan or application_attempt is referenced by them, so no
--   application history is lost:
--      drop table if exists public.dismissed_vacancies;
--      drop table if exists public.saved_vacancies;
--   To clear ONE candidate's decisions without dropping the feature:
--      delete from public.dismissed_vacancies where candidate_id = '<uuid>';
--      delete from public.saved_vacancies   where candidate_id = '<uuid>';
-- ---------------------------------------------------------------------------
