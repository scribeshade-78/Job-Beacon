-- Verified company facts foundation (R5.1; PRD §14.1 "Verified company
-- facts", §21.1 Company domain). companies (R2) is the minimal dedup/
-- identity stub this table extends 1:1 — its own migration comment
-- forward-declared this exact split: "legal_entity_id is deliberately
-- excluded — it belongs to the full company-intelligence /
-- registry-verification system (companies, company_legal_entities,
-- company_registry_records, company_profiles — PRD §21.1), which is R5
-- scope."
--
-- Only R5.1 scope: company_legal_entities, company_domains, and
-- company_registry_records (also named in PRD §21.1) are deliberately
-- NOT built here. Those three depend on a real registry-integration
-- decision (MCA/Companies House/SEC — which one first, API shape, rate
-- limits) that the jobbeacon-development skill requires spiking before
-- implementation; building their schema now would mean guessing at
-- fields ahead of that spike. This table has no such dependency — it's
-- just the fact list itself.
--
-- employee_size_range and official_social_links carry no CHECK-
-- constrained enumeration or fixed JSON shape — same "no taxonomy
-- invented until a real requirement defines one" precedent as
-- candidate_selected_roles.role_name and extracted_facts.fact_type; the
-- PRD does not define bucket values or a social-platform key set.
--
-- Explicitly excluded PRD §14.1 fields, not deferred silently:
-- - Legal/trading names, registration number/status: company_legal_entities (R5.2).
-- - Verified career domains/ATS boards: company_domains (R5.2); companies.domain/
--   career_domain (R2) remain the single-value placeholders until then.
-- - Employer-claimed profile status: no employer identity/auth/role exists
--   anywhere in this repository yet (only candidate and moderator roles do) —
--   this is a whole future feature, not a column.
-- - Active verified vacancy count: derived/computed, no aggregation pipeline
--   exists yet — "derive, don't duplicate" precedent (application_plans has
--   no status column for the same reason). Computable via a query against
--   vacancies later, not stored here.
create table public.company_profiles (
  company_id uuid primary key references public.companies (id) on delete cascade,

  headquarters_country text,
  operating_countries text[],
  industry text,
  founded_year integer,
  employee_size_range text,
  public_private_status text,
  official_social_links jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.company_profiles enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.company_profiles from public;
revoke all on public.company_profiles from anon;
revoke all on public.company_profiles from authenticated;

-- System/registry-derived data, not candidate-owned — same pattern as
-- companies itself (companies_select_all): visible to any signed-in
-- candidate, no per-owner scoping, no mutation grant for authenticated.
grant select on public.company_profiles to authenticated;
grant select, insert, update, delete on public.company_profiles to service_role;

create policy "company_profiles_select_all"
  on public.company_profiles
  for select
  to authenticated
  using (true);
