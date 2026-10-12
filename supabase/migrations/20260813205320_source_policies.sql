-- Source-policy registry (PRD §10.4, §21.1 Sources domain). One row per
-- provider (not per polled target — see vacancy_sources for that).
-- Application permissions are OFF for every source in R2: PRD §28 scopes
-- automated applications to R4, and the user's explicit R2 decision keeps
-- them off regardless of what a source would technically allow.
create table public.source_policies (
  source_code text primary key,
  discovery_allowed boolean not null default false,
  storage_allowed boolean not null default false,
  display_allowed boolean not null default false,
  automated_application_allowed boolean not null default false,
  authentication_method text not null,
  rate_limit text,
  countries text[] not null default '{}',
  policy_version text not null,
  last_legal_review_at timestamptz,
  -- PRD's own field name ("kill_switch: enabled/disabled") is ambiguous
  -- about which state true represents. Documented explicitly here rather
  -- than guessing: true = this source is killed (discovery must stop),
  -- matching the operational meaning of a kill switch, not "feature is on".
  kill_switch boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.source_policies enable row level security;

-- Internal governance/config data — not candidate-facing (PRD §19.2 "Source
-- management" is Moderator/Admin experience, not the candidate Opportunities
-- screen in §18.2). No grants to anon/authenticated at all; only the
-- server-side ingestion worker (service_role, which bypasses RLS but still
-- needs explicit table grants) reads/writes this table.
revoke all on public.source_policies from public;
revoke all on public.source_policies from anon;
revoke all on public.source_policies from authenticated;

grant select, insert, update, delete on public.source_policies to service_role;
