-- Polled targets (PRD §21.1 Sources domain: vacancy_sources, distinct from
-- source_policies which is the per-provider policy registry). One row per
-- specific thing to poll — a Greenhouse board_token, a Lever site slug, a
-- USAJOBS saved-search config, an Adzuna search config.
--
-- Ships empty: which real employers/boards to track is a business decision
-- this migration does not make (not specified anywhere in the PRD or by
-- explicit instruction) — populating real targets is a separate, later
-- step. Tests use fixture target rows, not real company data.
create table public.vacancy_sources (
  id uuid primary key default gen_random_uuid(),
  source_code text not null references public.source_policies (source_code),
  -- Per-provider target identifier: Greenhouse board_token, Lever site
  -- slug, or a stable label for a USAJOBS/Adzuna saved search.
  target_key text not null,
  -- Per-provider extra config the adapter needs (e.g. Adzuna country code
  -- and keyword filters, USAJOBS category code) — deliberately generic
  -- rather than one column per provider-specific parameter.
  config jsonb not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (source_code, target_key)
);

alter table public.vacancy_sources enable row level security;

revoke all on public.vacancy_sources from public;
revoke all on public.vacancy_sources from anon;
revoke all on public.vacancy_sources from authenticated;

-- Internal governance/config data, same reasoning as source_policies — not
-- part of the candidate-facing Opportunities screen (PRD §18.2).
grant select, insert, update, delete on public.vacancy_sources to service_role;
