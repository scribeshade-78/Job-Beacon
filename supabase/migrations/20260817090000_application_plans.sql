-- Application plan schema foundation (R4.1; PRD §16.1 eligibility gate,
-- §21.1 Applications domain, §21.2 "Application attempts are idempotent
-- per candidate + canonical vacancy"). Schema and RLS only, matching the
-- R3.1/R3.4 precedent — no gate-evaluation logic exists yet (that's R4.2);
-- this migration exists to have the table and boundaries verified first.
--
-- A "plan" is the recorded outcome of evaluating PRD §16.1's six gates
-- (source policy, vacancy trust, candidate eligibility, verified facts,
-- application support, consent/rate/idempotency) for one candidate against
-- one vacancy. It is NOT yet an attempt to submit anything — that's
-- application_attempts, created only once a plan's gates allow it.
--
-- Per the explicit R4 sequencing decision: two of the six gates (role
-- match and verified-facts) cannot pass yet, because candidate_selected_roles
-- (PRD §9.1) and extracted_facts/fact_confirmations (PRD §21.1 Resume
-- domain) do not exist anywhere in this repository. gate_results is
-- deliberately generic JSONB — same precedent as vacancy_evidence.payload
-- and moderation_cases.evidence_snapshot — so R4.2 can record each gate's
-- pass/fail and reason code (including the two permanent hard-block reason
-- codes for the missing systems) without this migration inventing a typed
-- shape for gate logic that doesn't exist yet.
--
-- unique (candidate_id, vacancy_id) is the literal idempotency anchor PRD
-- §21.2 requires: at most one plan can ever exist for a given candidate +
-- canonical vacancy pair, so re-running gate evaluation on the same pair
-- is naturally idempotent at the database level, not just in application
-- code.
create table public.application_plans (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,
  vacancy_id uuid not null references public.vacancies (id),

  gate_results jsonb not null,

  created_at timestamptz not null default now(),

  unique (candidate_id, vacancy_id)
);

create index application_plans_vacancy_id_idx on public.application_plans (vacancy_id);

alter table public.application_plans enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.application_plans from public;
revoke all on public.application_plans from anon;
revoke all on public.application_plans from authenticated;

-- Candidate-facing read surface for PRD §18.1's "Applications" nav item —
-- but a plan is system-generated (the outcome of gate evaluation), never
-- candidate-authored, so no INSERT/UPDATE/DELETE grant exists for
-- authenticated. This is the vacancies precedent (candidate SELECT-only,
-- writes are worker-only), not the automation_authorizations precedent
-- (candidate-writable, because that table records the candidate's own
-- consent action).
grant select on public.application_plans to authenticated;
grant select, insert, update, delete on public.application_plans to service_role;

create policy "application_plans_select_own"
  on public.application_plans
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);
