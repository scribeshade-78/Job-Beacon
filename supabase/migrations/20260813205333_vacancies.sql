-- Canonical vacancy model (PRD §11.2). Field groups included for R2:
-- Identity, Role (partial), Location, Compensation, Lifecycle. Field
-- groups deliberately NOT included:
--   - Trust (source confidence, vacancy_trust_status, hard_block_reasons):
--     PRD §28 scopes trust scoring to R3 ("Trust and moderation"). Adding
--     these columns now would mean either meaningless placeholders or
--     inventing R3 scoring logic prematurely.
--   - Application (channel, required_fields, action_required_capabilities):
--     R4 scope ("Authorized automatic applications"), same reasoning.
-- Both are additive migrations when their phases arrive.
create table public.vacancies (
  id uuid primary key default gen_random_uuid(),

  -- Identity (§11.2). vacancy_source_id (the specific polled target, not
  -- just the provider) is required for correct per-target freshness
  -- tracking (§11.1 step 21) — a provider like Greenhouse has many
  -- independent targets (one per employer board), and "not seen in this
  -- run" is only meaningful scoped to one target, not the whole provider.
  source_code text not null references public.source_policies (source_code),
  vacancy_source_id uuid not null references public.vacancy_sources (id),
  source_vacancy_id text not null,
  authoritative_url text not null,

  -- Role (§11.2) — canonical_role_id/seniority/function/skill_requirements
  -- are deliberately NOT included here. Resolving them needs a role
  -- taxonomy, which does not exist anywhere in this repository — the same
  -- gap already identified and left unimplemented in R1 (manual role
  -- search was reported blocked for the identical reason: no taxonomy
  -- source exists in the PRD or repo). Adding these columns now, unable to
  -- ever populate them, would be worse than omitting them; they're added
  -- additively once a taxonomy exists.
  raw_title text not null,

  -- Company (§11.2) — legal_entity_id excluded, see companies migration.
  company_id uuid references public.companies (id),

  -- Location (§11.2)
  country text,
  region text,
  city text,
  remote_type text check (remote_type in ('remote', 'hybrid', 'on_site')),

  -- Compensation (§11.2). salary_source values match §15.1's source
  -- hierarchy labels that are actually reachable from R2 discovery data
  -- (employer_disclosed appears in adapter-provided salary fields;
  -- everything past that in §15.1's hierarchy — government benchmark,
  -- licensed estimate, verified observation, model estimate — needs
  -- systems R2 doesn't build).
  currency text,
  salary_min numeric,
  salary_max numeric,
  salary_interval text check (salary_interval in ('year', 'month', 'hour')),
  salary_source text check (salary_source in ('employer_disclosed', 'estimated')),

  -- Lifecycle (§11.2). status here is the raw listing's own liveness at
  -- the source (freshness) — not to be confused with R3's separate
  -- vacancy_trust_status concept, which this table does not have.
  published_at timestamptz,
  discovered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'expired', 'removed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Dedup rule 1 (§11.3): exact source ID match.
  unique (source_code, source_vacancy_id)
);

create index vacancies_company_id_idx on public.vacancies (company_id);
create index vacancies_status_idx on public.vacancies (status);
create index vacancies_vacancy_source_id_status_idx on public.vacancies (vacancy_source_id, status);
-- Dedup rule 2 (§11.3): canonical URL match.
create unique index vacancies_authoritative_url_idx on public.vacancies (authoritative_url);

alter table public.vacancies enable row level security;

revoke all on public.vacancies from public;
revoke all on public.vacancies from anon;
revoke all on public.vacancies from authenticated;

-- Candidate-facing (PRD §18.2 Opportunities screen: "opportunities
-- discovered and verified by JobBeacon"). SELECT only — writes are
-- ingestion-worker-only per the explicit R2 access-model decision.
grant select on public.vacancies to authenticated;
grant select, insert, update, delete on public.vacancies to service_role;

create policy "vacancies_select_all"
  on public.vacancies
  for select
  to authenticated
  using (true);
