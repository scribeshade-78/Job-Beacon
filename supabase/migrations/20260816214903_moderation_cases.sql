-- Moderation case foundation (PRD §13.2 workflow steps 23-26, §21.1 Trust
-- domain). Schema and RLS only, matching the R3.1 precedent — no
-- case-creation logic exists yet (that's a later mini-phase); this
-- migration exists to have the tables and boundaries verified first.
--
-- No `status` column: a case's resolution state is fully derivable from
-- whether a moderation_decisions row exists for it (moderation_decisions
-- is append-only and 1-to-many per case, covering both the initial
-- decision and any later appeal decision — §13.2 step 32 "final decision
-- retained in audit history"). Inventing a separate case-status enum the
-- PRD doesn't name would duplicate that same information under a second,
-- driftable source of truth.
create table public.moderation_cases (
  id uuid primary key default gen_random_uuid(),

  -- What the case is about. Company/source linkage (§13.2 step 26 "Related
  -- company, source ... linked") is transitively available via
  -- vacancies.company_id/source_code — not duplicated here.
  vacancy_id uuid not null references public.vacancies (id),

  -- §13.2 step 23 "Case created by rule, report or appeal" + §13.1's
  -- moderation-layer table (Automated / Candidate & community reports /
  -- Employer claim & appeal).
  source_type text not null check (source_type in (
    'rule',
    'candidate_report',
    'community_report',
    'employer_appeal'
  )),

  -- §13.2 step 24 "Severity ... assigned", §13.3's SLA table.
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),

  -- §13.2 step 25 "Evidence snapshot frozen". Generic JSONB, same reasoning
  -- as R3.1's vacancy_evidence.payload — no case-creation logic exists yet
  -- to populate a more specific shape.
  evidence_snapshot jsonb not null,

  -- §13.2 step 26 "... and duplicate cases linked". Self-referential,
  -- nullable — not every case has a known related case.
  related_case_id uuid references public.moderation_cases (id),

  created_at timestamptz not null default now()
);

create index moderation_cases_vacancy_id_idx on public.moderation_cases (vacancy_id);
create index moderation_cases_related_case_id_idx on public.moderation_cases (related_case_id);

alter table public.moderation_cases enable row level security;

-- Service-role only for now — no moderator/admin role exists anywhere in
-- this codebase yet (same gap already noted for the trust tables in R3.1).
-- A moderator-role policy is added once that role actually exists.
revoke all on public.moderation_cases from public;
revoke all on public.moderation_cases from anon;
revoke all on public.moderation_cases from authenticated;

grant select, insert, update, delete on public.moderation_cases to service_role;
