-- Minimal R2 company stub (user's explicit decision: only the fields the
-- canonical vacancy model needs, PRD §11.2 Company group). legal_entity_id
-- is deliberately excluded — it belongs to the full company-intelligence /
-- registry-verification system (companies, company_legal_entities,
-- company_registry_records, company_profiles — PRD §21.1), which is R5
-- scope (§28) and out of scope here. career_domain is included: unlike
-- legal-entity verification, it's directly derivable from source discovery
-- itself (a Greenhouse/Lever board is hosted under the employer's own
-- career subdomain) and is one of §11.2's Company group fields, not a
-- registry-verification concept.
-- displayed_name is the get-or-create dedup key the ingestion worker uses
-- (unique, safe upsert via ON CONFLICT). A known, documented R2 limitation
-- of this minimal stub: two genuinely different companies that happen to
-- share a display name will incorrectly merge. Real identity
-- disambiguation (domain/legal-entity matching) is R5 scope.
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  displayed_name text not null unique,
  domain text,
  career_domain text,
  created_at timestamptz not null default now()
);

alter table public.companies enable row level security;

revoke all on public.companies from public;
revoke all on public.companies from anon;
revoke all on public.companies from authenticated;

-- Candidate-facing: company name/domain is core to displaying a vacancy
-- (PRD §18.2 "Company profile summary" on the Opportunities screen).
grant select on public.companies to authenticated;
grant select, insert, update, delete on public.companies to service_role;

create policy "companies_select_all"
  on public.companies
  for select
  to authenticated
  using (true);
