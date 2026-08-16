-- Trust scoring history (PRD §12.1 status model, §21.1 Trust domain).
-- One row per scoring run — append-only, never updated, mirroring the
-- vacancy_versions immutability pattern from R2. vacancies.trust_status
-- (see the vacancies_add_trust_status migration) is the denormalized
-- "current" pointer; this table is the authoritative scored history.
--
-- Deliberately minimal for R3.1 (schema foundation only, no scoring logic
-- yet): `score` holds the overall weighted result once R3.3 implements the
-- §12.2 dimension computation — nullable because a hard-block short-circuit
-- can produce a status without a meaningful numeric score ("hard-block
-- rules override the numeric result", §12.2). Per-dimension score columns
-- (employer identity, source authority, etc.) are NOT added here — that
-- shape belongs to R3.3's scoring implementation, not this schema pass.
--
-- policy_version is a plain text column, not a FK to a policy_versions
-- table — PRD §21.1 lists policy_versions under the Audit domain as a
-- separate, not-yet-built entity. Modeling that FK now would invent a
-- table this migration doesn't create; the text column is upgraded to a FK
-- additively once policy_versions exists.
create table public.vacancy_trust_scores (
  id uuid primary key default gen_random_uuid(),
  vacancy_id uuid not null references public.vacancies (id),

  -- PRD §12.1 status model, verbatim.
  status text not null check (status in (
    'VERIFIED',
    'VERIFIED_INCOMPLETE',
    'UNDER_REVIEW',
    'FLAGGED',
    'BLOCKED',
    'EXPIRED_REMOVED',
    'ACTION_REQUIRED'
  )),

  score numeric,
  policy_version text not null,

  scored_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index vacancy_trust_scores_vacancy_id_idx on public.vacancy_trust_scores (vacancy_id, scored_at desc);

alter table public.vacancy_trust_scores enable row level security;

revoke all on public.vacancy_trust_scores from public;
revoke all on public.vacancy_trust_scores from anon;
revoke all on public.vacancy_trust_scores from authenticated;

-- Service-role only in R3.1 — PRD §19.1 lists reason codes and score
-- breakdown as moderator-dashboard content, not candidate-facing. A
-- moderator-role policy is added in R3.6 when that role actually exists;
-- no moderator/admin role exists anywhere in this codebase yet.
grant select, insert, update, delete on public.vacancy_trust_scores to service_role;
