-- Verified legal-entity identity (R5.4; PRD §14.1 "Legal and trading
-- names, Registration number and status ... Public/private status where
-- known", §21.1 Company domain). Deferred out of R5.1 pending the R5.3
-- registry-API spike; this migration's column shape is informed by that
-- spike's findings for India's MCA Company Master Data (medium
-- confidence — corroborated across secondary sources, not verified
-- against a live API response, since data.gov.in's catalog page returned
-- HTTP 403 to a direct fetch during the spike).
--
-- jurisdiction/registry_identifier are deliberately generic (not
-- "cin"/"country_in") — MCA (India) is the first target, but Companies
-- House (UK) and SEC (US) use different identifier types (§14.1's own
-- three named registries), so this shape is meant to fit all three
-- without a later rename.
--
-- company_class is MCA's own field for §14.1's "Public/private status
-- where known" — a real finding from the R5.3 spike report, not a
-- guess. registration_status/company_category/company_class carry no
-- CHECK-constrained enumeration: MCA's exact status vocabulary was not
-- independently confirmed during the spike (medium-confidence secondary
-- sources only), so inventing a fixed value set here would be guessing
-- at a taxonomy the spike explicitly could not verify.
--
-- One company can have more than one legal_entities row over time (a
-- registry re-lookup can find a status/capital change, or a company
-- operates through more than one registered entity across jurisdictions),
-- so this is a separate table rather than columns bolted onto companies —
-- same "append-oriented chain, not an overwritten single record"
-- reasoning as vacancy_trust_scores relative to vacancies.
create table public.company_legal_entities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,

  jurisdiction text not null,
  registry_identifier text not null,
  legal_name text not null,

  registration_status text,
  registration_date date,
  company_category text,
  company_class text,

  authorized_capital numeric,
  paid_up_capital numeric,
  capital_currency text,

  registered_region text,
  registrar text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index company_legal_entities_company_id_idx on public.company_legal_entities (company_id);

alter table public.company_legal_entities enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.company_legal_entities from public;
revoke all on public.company_legal_entities from anon;
revoke all on public.company_legal_entities from authenticated;

-- System/registry-derived data, not candidate-owned — same pattern as
-- companies/company_profiles: visible to any signed-in candidate, no
-- per-owner scoping, no mutation grant for authenticated.
grant select on public.company_legal_entities to authenticated;
grant select, insert, update, delete on public.company_legal_entities to service_role;

create policy "company_legal_entities_select_all"
  on public.company_legal_entities
  for select
  to authenticated
  using (true);
