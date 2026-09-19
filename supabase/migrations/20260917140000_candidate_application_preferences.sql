-- Mini-Phase 1: Auto-Apply preferences on candidate_profiles.
--
-- Two preference columns, nothing more. This phase deliberately records what
-- the candidate chose and does not touch eligibilityGate.ts, the application
-- worker or automation_authorizations — see the "record preference only"
-- scope note below.
--
-- TEXT + CHECK, not a Postgres enum type. Every other constrained value in
-- this schema is spelled this way (automation_authorizations.status,
-- vacancies.status, ingestion_jobs.status, application_attempts.status), and
-- an enum type would need its own ALTER TYPE migration to add a fourth
-- resume-optimization level later. It also keeps the values legible in a
-- plain `select *`, which matters for the operators reading this table.
--
-- review_before_submit defaults TRUE on purpose. The safe direction for a
-- switch whose OFF position means "let automation submit without me looking"
-- is the one that requires an explicit, deliberate opt-out — a default of
-- false would silently enrol every existing and future candidate in the
-- riskier behaviour. resume_optimization_level defaults to 'honest' for the
-- same reason: the middle option is the one that neither fabricates nor
-- withholds, so it is the honest default for a field a candidate has not yet
-- thought about.
alter table public.candidate_profiles
  add column resume_optimization_level text not null default 'honest'
    check (resume_optimization_level in ('off', 'honest', 'aggressive')),
  add column review_before_submit boolean not null default true;

comment on column public.candidate_profiles.resume_optimization_level is
  'How aggressively the generated resume may be optimised: off | honest | aggressive. Recorded preference only in Mini-Phase 1 — no engine reads this yet.';

comment on column public.candidate_profiles.review_before_submit is
  'True = the candidate reviews before anything is submitted. False implies auto-approve, which per product direction only takes effect when an explicit automation_authorizations consent row also exists. Recorded preference only in Mini-Phase 1 — no engine reads this yet.';

-- ---------------------------------------------------------------------------
-- Write access. This table was created with "grant select, insert" and
-- nothing else (20260812231617), because until now it held only id and
-- created_at — there was nothing a candidate could legitimately change, so
-- there was no UPDATE grant and no UPDATE policy. Adding the first writable
-- columns means adding the first real write path, and it needs BOTH halves:
-- without the grant PostgREST returns 42501 before RLS is even consulted,
-- and without the policy the grant alone would let a candidate update
-- another candidate's row.
--
-- The grant is column-scoped rather than table-wide, following the same
-- "grant back only what this slice needs" reasoning that migration already
-- documents: a candidate has no business rewriting their own primary key or
-- created_at, and a column-level UPDATE grant makes that structurally
-- impossible rather than merely unoffered by the UI.
-- ---------------------------------------------------------------------------
grant update (resume_optimization_level, review_before_submit)
  on public.candidate_profiles
  to authenticated;

create policy "candidate_profiles_update_own"
  on public.candidate_profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
