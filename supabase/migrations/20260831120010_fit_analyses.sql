-- Response Intelligence Phase 2.1 — Fit Analysis (Opportunity Intelligence
-- PRD §11.2 Resume Match Breakdown / Technical Fit, §11.3 Eligibility
-- Rules, §12.1 "top reasons and risks"). One current analysis per
-- (candidate, vacancy) pair.
--
-- Technical Fit (technical_fit_score / technical_fit_components /
-- missing_evidence / top_reasons / risks) comes from an AI call
-- (server/opportunities/fitPrompt.ts, OpenRouter) comparing the JD text
-- against the candidate's *confirmed* facts. It is NULLABLE: when the
-- provider payload carried no usable JD text (jd_text_available = false),
-- there is structurally nothing to analyse — the row is still written with
-- Practical Eligibility only, and the job is NOT retried.
--
-- Practical Eligibility (practical_eligibility_score / hard_blockers /
-- soft_penalties / eligibility_capped) comes from a deterministic pure-TS
-- rules engine (server/opportunities/practicalEligibility.ts). v1 is
-- location-only: a non-remote role in a country the candidate is not in is
-- a LOCATION_PRESENCE hard blocker, which caps practical_eligibility_score
-- to 0 and sets eligibility_capped = true (§11.3 "Cap score to 0").
-- Technical Fit is still computed and stored in that case — "great
-- technical fit but you can't work there" is exactly the §12.1 risk
-- surface. The §12.1 weighted 8-factor priority score is Phase 2.2 and
-- will read eligibility_capped to force itself to 0.
--
-- Reason codes (hard_blockers[].code, soft_penalties[].code) are stable
-- SCREAMING_SNAKE strings owned by server/opportunities/reasonCodes.ts —
-- no CHECK constraint here, same "code owns the taxonomy until a PRD
-- enumerates it" precedent as response_classifications.category and
-- vacancy trust reason codes.
create table public.fit_analyses (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,
  vacancy_id uuid not null references public.vacancies (id) on delete cascade,

  -- Which JD version this analysis was computed against. NULL when no JD
  -- text was available (no vacancy_jd_snapshots row was created).
  jd_snapshot_id uuid references public.vacancy_jd_snapshots (id),
  jd_text_available boolean not null default false,

  -- Technical Fit (§11.2) — NULL when jd_text_available = false.
  technical_fit_score int check (technical_fit_score >= 0 and technical_fit_score <= 100),
  technical_fit_components jsonb,       -- { core_technical_skills: {score,rationale}, cloud_alignment: {...}, ... } (6 dims)
  missing_evidence jsonb not null default '[]'::jsonb,   -- string[]

  -- Practical Eligibility (§11.3). score NULL when INSUFFICIENT_DATA
  -- (candidate has no confirmed location fact).
  practical_eligibility_score int check (practical_eligibility_score >= 0 and practical_eligibility_score <= 100),
  hard_blockers jsonb not null default '[]'::jsonb,      -- [{ code, detail }]
  soft_penalties jsonb not null default '[]'::jsonb,     -- [{ code, detail }] — empty in v1
  eligibility_capped boolean not null default false,     -- true => 2.2 priority score forced to 0

  -- §12.1 "top reasons and risks" — free text from the AI, advisory.
  top_reasons jsonb not null default '[]'::jsonb,        -- string[]
  risks jsonb not null default '[]'::jsonb,              -- string[]

  model_version text not null,
  prompt_version text not null,

  analyzed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- One current analysis per pair; the worker upserts on conflict (facts
  -- changed / JD changed / prompt bumped) rather than accumulating rows.
  unique (candidate_id, vacancy_id)
);

create index fit_analyses_candidate_id_idx on public.fit_analyses (candidate_id);
create index fit_analyses_vacancy_id_idx on public.fit_analyses (vacancy_id);

alter table public.fit_analyses enable row level security;

revoke all on public.fit_analyses from public;
revoke all on public.fit_analyses from anon;
revoke all on public.fit_analyses from authenticated;

-- Candidate-facing read surface only — a fit analysis is system-generated
-- output (the application_plans precedent), never candidate-authored, so
-- authenticated gets SELECT only, scoped to the owning candidate. Writes
-- are worker-only.
grant select on public.fit_analyses to authenticated;
grant select, insert, update, delete on public.fit_analyses to service_role;

create policy "fit_analyses_select_own"
  on public.fit_analyses
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);
