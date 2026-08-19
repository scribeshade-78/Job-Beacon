-- Raw registry lookup evidence (R5.4; PRD §14.1 verified company facts,
-- §21.1 Company domain). Same "generic JSONB, provenance/evidence
-- snapshot" precedent as vacancy_evidence.payload and
-- application_plans.gate_results: the exact response shape of a real
-- registry lookup (MCA today, Companies House/SEC later) is not
-- something this migration should invent typed columns for, especially
-- given the R5.3 spike could not verify a live API response.
--
-- Links to companies, not company_legal_entities: a lookup can return
-- zero or multiple candidate matches before any company_legal_entities
-- row is created or confirmed from it — recording the raw evidence must
-- not depend on that row already existing.
create table public.company_registry_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,

  registry_source text not null,
  raw_payload jsonb not null,
  retrieved_at timestamptz not null default now(),

  created_at timestamptz not null default now()
);

create index company_registry_records_company_id_idx on public.company_registry_records (company_id);

alter table public.company_registry_records enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.company_registry_records from public;
revoke all on public.company_registry_records from anon;
revoke all on public.company_registry_records from authenticated;

-- System/registry-derived data, not candidate-owned — same pattern as
-- companies/company_profiles/company_legal_entities.
grant select on public.company_registry_records to authenticated;
grant select, insert, update, delete on public.company_registry_records to service_role;

create policy "company_registry_records_select_all"
  on public.company_registry_records
  for select
  to authenticated
  using (true);
