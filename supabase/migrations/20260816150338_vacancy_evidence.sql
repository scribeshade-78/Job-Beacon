-- Evidence snapshots supporting a trust score (PRD §13.2 "Evidence snapshot
-- frozen", §21.2 "Trust decisions reference evidence and policy/model
-- versions"). References the specific vacancy_trust_scores row the
-- evidence supports.
--
-- Deliberately generic in R3.1: no concrete evidence-capture logic exists
-- yet (that's R3.2/R3.3 — the hard-block rule engine and scoring
-- computation). `payload` is JSONB so whatever a future detector captures
-- (URL response data, domain checks, duplicate-match details, etc.) has
-- somewhere to land without this migration inventing specific typed
-- columns for evidence shapes that don't exist in code yet.
create table public.vacancy_evidence (
  id uuid primary key default gen_random_uuid(),
  vacancy_trust_score_id uuid not null references public.vacancy_trust_scores (id),

  evidence_type text not null,
  payload jsonb not null,

  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index vacancy_evidence_vacancy_trust_score_id_idx on public.vacancy_evidence (vacancy_trust_score_id);

alter table public.vacancy_evidence enable row level security;

revoke all on public.vacancy_evidence from public;
revoke all on public.vacancy_evidence from anon;
revoke all on public.vacancy_evidence from authenticated;

-- Service-role only in R3.1, same reasoning as vacancy_trust_scores.
grant select, insert, update, delete on public.vacancy_evidence to service_role;
