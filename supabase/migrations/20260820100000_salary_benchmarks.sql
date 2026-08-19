-- Salary Intelligence foundation, tier 2 only (R5.2; PRD §15.1 source
-- hierarchy priority 2 "Government or official occupational benchmark",
-- §21.1 Salary domain). PRD §21.1 names three Salary entities —
-- salary_observations, salary_benchmarks, salary_estimates — matching
-- §15.1's 5-tier hierarchy. Only salary_benchmarks is built here:
--
-- - salary_observations (tier 4, JobBeacon-verified employee/offer
--   observations) holds individual-level compensation data. §15.2 is
--   explicit: "Do not publish individual compensation data ... apply
--   minimum sample and privacy thresholds to JobBeacon aggregates." That
--   needs its own careful privacy-threshold design, not a schema-only
--   pass — deferred to a later R5 mini-phase.
-- - salary_estimates (tiers 3 and 5, licensed market data API estimates
--   and JobBeacon's own model estimates) depends on picking a licensed
--   data provider and/or building a model — neither decision is made yet,
--   the same "needs its own spike" situation as the registry tables
--   deferred out of R5.1 (company_legal_entities etc.).
--
-- salary_benchmarks is government/official reference data, not individual
-- disclosures — same risk profile as company_profiles/companies
-- (system-authored, candidate-readable, no privacy-threshold logic
-- required).
--
-- role_label carries no CHECK-constrained enumeration or taxonomy — same
-- "no taxonomy invented until a real requirement defines one" precedent
-- as candidate_selected_roles.role_name. salary_interval reuses
-- vacancies.salary_interval's exact enum ('year', 'month', 'hour') for
-- consistency across the two salary-bearing tables in this repository.
--
-- analytical_currency/analytical_salary_min/analytical_salary_max are
-- nullable and populated by nothing yet — they exist to satisfy PRD
-- §15.3's explicit storage rule ("Original currency + normalized
-- analytical currency") ahead of any currency-normalization pipeline,
-- the same "schema ready to receive future logic" precedent as
-- action_required_events.resolved_at being nullable until R4.7 populated
-- it.
create table public.salary_benchmarks (
  id uuid primary key default gen_random_uuid(),

  role_label text not null,
  region text,

  currency text not null,
  salary_interval text not null check (salary_interval in ('year', 'month', 'hour')),
  salary_min numeric,
  salary_max numeric,

  benchmark_source text not null,
  effective_date date,

  analytical_currency text,
  analytical_salary_min numeric,
  analytical_salary_max numeric,

  created_at timestamptz not null default now()
);

alter table public.salary_benchmarks enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.salary_benchmarks from public;
revoke all on public.salary_benchmarks from anon;
revoke all on public.salary_benchmarks from authenticated;

-- System/registry-derived reference data, not candidate-owned — same
-- pattern as companies/company_profiles: visible to any signed-in
-- candidate, no per-owner scoping, no mutation grant for authenticated.
grant select on public.salary_benchmarks to authenticated;
grant select, insert, update, delete on public.salary_benchmarks to service_role;

create policy "salary_benchmarks_select_all"
  on public.salary_benchmarks
  for select
  to authenticated
  using (true);
