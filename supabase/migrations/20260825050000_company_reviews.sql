-- R5.3: first-party company review foundation (PRD §14.2 "Separate company
-- scores" — Work-Life Balance / Compensation & Benefits / Management &
-- Culture / Career Growth, all four sourced from "verified employee
-- reviews" — and §14.3 "First-party review system"). Schema and RLS only,
-- same "foundation before workflow" precedent as moderation_cases
-- (20260816214903): no submission-abuse checks, moderation queue wiring,
-- or employer response rights are built here — this migration exists to
-- have the table and its anonymity boundary verified first.
--
-- Four rating columns, not five: PRD §14.2 lists "Management & Culture" as
-- one combined dimension, not two — management_and_culture matches that
-- exactly rather than splitting it (explicit founder decision this phase).
--
-- reviewer_id references candidate_profiles, not auth.users directly —
-- unlike moderation_decisions.reviewer_id (a moderator, who need not be a
-- candidate), a company reviewer is always a candidate in this product.
--
-- unique(company_id, reviewer_id) is permanent, not period-bound. PRD
-- §14.3 says "one review per user per company within a defined period",
-- but no period value is specified anywhere in the PRD — inventing one
-- (e.g. "1 year") would be a guess this project's own rules forbid (same
-- "no taxonomy invented until a real requirement defines one" precedent as
-- extracted_facts.fact_type/candidate_selected_roles.role_name). This is
-- the honest permanent version of the constraint; period-based
-- re-eligibility is deferred until a founder decision names an actual
-- period.
--
-- verification_status is code-owned (pending/verified/rejected, mirroring
-- fact_confirmations.status's shape) — the PRD names four verification
-- *methods* (§14.3: corporate email, redacted employment document,
-- verified offer/interview evidence, consented mailbox evidence) but no
-- status vocabulary; company_review_verifications (next migration) records
-- the method, this column records the outcome.
create table public.company_reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  reviewer_id uuid not null references public.candidate_profiles (id) on delete cascade,

  work_life_balance smallint not null check (work_life_balance between 1 and 5),
  compensation smallint not null check (compensation between 1 and 5),
  management_and_culture smallint not null check (management_and_culture between 1 and 5),
  career_growth smallint not null check (career_growth between 1 and 5),

  review_text text,

  verification_status text not null default 'pending' check (verification_status in ('pending', 'verified', 'rejected')),

  created_at timestamptz not null default now(),

  unique (company_id, reviewer_id)
);

create index company_reviews_company_id_idx on public.company_reviews (company_id);
create index company_reviews_reviewer_id_idx on public.company_reviews (reviewer_id);

alter table public.company_reviews enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.company_reviews from public;
revoke all on public.company_reviews from anon;
revoke all on public.company_reviews from authenticated;

-- No UPDATE/DELETE grant for authenticated: reviews aren't editable or
-- retractable by the candidate in this pass — the PRD doesn't specify an
-- edit window, and "immutable once submitted" is the safer default until
-- one is defined (same reasoning fact_confirmations' own migration gives
-- for why moderation_decisions has no DELETE).
grant select, insert on public.company_reviews to authenticated;
grant select, insert, update, delete on public.company_reviews to service_role;

-- Candidates can see and create their own review row (any status,
-- including pending/rejected) — this is their own submission, not the
-- anonymized public read. Reading OTHER candidates' verified reviews goes
-- through company_reviews_public below, never this base-table policy —
-- that's what keeps reviewer_id from ever being visible to anyone but the
-- reviewer themselves and service_role.
create policy "company_reviews_select_own"
  on public.company_reviews
  for select
  to authenticated
  using ((select auth.uid()) = reviewer_id);

create policy "company_reviews_insert_own"
  on public.company_reviews
  for insert
  to authenticated
  with check ((select auth.uid()) = reviewer_id);

-- Anonymous public read surface (PRD §14.3 "Anonymous public display with
-- internal relationship-verification status"): reviewer_id is not a column
-- of this view at all, and verification_status is filtered to 'verified'
-- in the view definition itself, not left to a caller-supplied filter.
--
-- This view is owned by the migration-running role, which also owns
-- company_reviews — Postgres RLS is bypassed for a table's owner by
-- default (unless FORCE ROW LEVEL SECURITY is set, which it isn't here),
-- and a view's access to its underlying tables is checked against the
-- VIEW OWNER's privileges, not the querying user's. That combination is
-- what lets this view show every verified row to every authenticated
-- candidate, not just the querying candidate's own rows — the base
-- table's "own rows only" RLS policies above do not apply when the data is
-- read through this view. This is the standard, documented Postgres/
-- Supabase pattern for a public/anonymized slice of an RLS-protected
-- table, not a workaround.
create view public.company_reviews_public as
  select
    id,
    company_id,
    work_life_balance,
    compensation,
    management_and_culture,
    career_growth,
    review_text,
    created_at
  from public.company_reviews
  where verification_status = 'verified';

revoke all on public.company_reviews_public from public;
revoke all on public.company_reviews_public from anon;
revoke all on public.company_reviews_public from authenticated;

grant select on public.company_reviews_public to authenticated;
