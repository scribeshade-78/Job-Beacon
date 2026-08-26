-- Employer-submitted fact corrections (R5.4b; PRD §20.2 "Correct objective
-- company facts with evidence"). Per explicit R5.4a decision, corrections
-- never write companies/company_profiles directly — every one routes
-- through a moderator decision, same trust model as employer_claims.
--
-- Flat single table, not a companies/decisions split like
-- employer_claims/employer_claim_decisions: unlike a claim (the same row
-- gets re-reviewed across resubmissions via its unique-pair upsert), a
-- correction has no such reuse — each submission is its own fresh row,
-- reviewed exactly once, so reviewer_id/rationale/decided_at fit directly
-- on this table without losing any history.
--
-- field_name bakes in the target table ('companies.domain',
-- 'company_profiles.founded_year', ...) rather than a separate
-- table_name column — one column, no invalid table+field combination is
-- representable. The eight values here are exactly R5.4b's approved
-- scalar allow-list; company_profiles.operating_countries (text[]) and
-- official_social_links (jsonb) are deliberately excluded — proposed_value
-- is a single text column, and a real polymorphic value-shape system for
-- two structured fields isn't justified by anything in §20.2 yet.
--
-- employer_claim_id (not just company_id) ties every correction back to
-- the specific verified claim that authorized it — company_id is kept too,
-- denormalized, since every consuming query (the moderator queue, RLS)
-- needs it and re-deriving it via a join every time would be pure overhead
-- for a value that never changes after insert.
create table public.company_fact_corrections (
  id uuid primary key default gen_random_uuid(),
  employer_claim_id uuid not null references public.employer_claims (id),
  company_id uuid not null references public.companies (id),

  field_name text not null check (field_name in (
    'companies.displayed_name',
    'companies.domain',
    'companies.career_domain',
    'company_profiles.headquarters_country',
    'company_profiles.industry',
    'company_profiles.founded_year',
    'company_profiles.employee_size_range',
    'company_profiles.public_private_status'
  )),
  proposed_value text not null,
  evidence text,

  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewer_id uuid references auth.users (id),
  rationale text,
  decided_at timestamptz,

  created_at timestamptz not null default now()
);

create index company_fact_corrections_company_id_idx on public.company_fact_corrections (company_id);
create index company_fact_corrections_employer_claim_id_idx on public.company_fact_corrections (employer_claim_id);
create index company_fact_corrections_status_idx on public.company_fact_corrections (status);

alter table public.company_fact_corrections enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.company_fact_corrections from public;
revoke all on public.company_fact_corrections from anon;
revoke all on public.company_fact_corrections from authenticated;

-- Candidate-facing SELECT only, no candidate INSERT/UPDATE grant:
-- submission and moderator decisions both complete via server-side routes
-- under service_role — same "system-generated, worker-written" precedent
-- as employer_claims/mailbox_connections.
grant select on public.company_fact_corrections to authenticated;
grant select, insert, update, delete on public.company_fact_corrections to service_role;

-- Same transitive-ownership shape as employer_claim_decisions_select_own:
-- the employer can see their own corrections (and their outcome) without
-- a direct FK to auth.uid() on this table.
create policy "company_fact_corrections_select_own"
  on public.company_fact_corrections
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.employer_claims ec
      where ec.id = company_fact_corrections.employer_claim_id
        and ec.user_id = (select auth.uid())
    )
  );
