-- Application attempt lifecycle (R4.1; PRD §16.4 worker lifecycle,
-- §21.1 Applications domain). Schema and RLS only — the worker that
-- leases and executes these rows is R4.3, not this migration.
--
-- Column shape and lease semantics deliberately mirror ingestion_jobs
-- (the R2 minimal Postgres-backed lease queue: status + attempts +
-- max_attempts + leased_until + last_error, with a (status, leased_until)
-- index supporting a future SELECT ... FOR UPDATE SKIP LOCKED claim
-- query). Same reasoning applies here as it did for ingestion: this
-- project's queue needs are a handful of concurrent workers, not
-- pg-boss's retry/backoff sophistication, and the jobbeacon-development
-- skill requires a compatibility spike before adopting pg-boss anyway.
-- Reusing the proven ingestion_jobs shape instead of inventing a second
-- queue pattern is the smaller, safer diff.
--
-- One application_plans row can have more than one attempt over time
-- (e.g. a failed attempt that's retried), so this is a separate table
-- rather than lease columns bolted directly onto application_plans —
-- keeping application_plans' one-row-per-(candidate,vacancy) idempotency
-- guarantee intact regardless of how many times submission is retried.
--
-- No ON DELETE CASCADE on application_plan_id: matches the
-- moderation_decisions -> moderation_cases precedent (plain FK, no
-- cascade) for this kind of internal append-oriented chain, as opposed
-- to the auth.users -> candidate_profiles -> resume_documents chain
-- where cascade-on-account-deletion is the correct behavior.
create table public.application_attempts (
  id uuid primary key default gen_random_uuid(),
  application_plan_id uuid not null references public.application_plans (id),

  -- §16.4 worker lifecycle states: leased, submitted-and-classified as
  -- succeeded/failed, or paused because of an §17 action-required
  -- exception. 'pending' is the initial state before any worker has
  -- claimed the attempt.
  status text not null default 'pending' check (status in (
    'pending',
    'leased',
    'succeeded',
    'failed',
    'action_required'
  )),

  attempts integer not null default 0,
  max_attempts integer not null default 5,
  leased_until timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Supports the future worker's claim query, same shape as
-- ingestion_jobs_status_leased_until_idx.
create index application_attempts_status_leased_until_idx on public.application_attempts (status, leased_until);
create index application_attempts_application_plan_id_idx on public.application_attempts (application_plan_id);

alter table public.application_attempts enable row level security;

revoke all on public.application_attempts from public;
revoke all on public.application_attempts from anon;
revoke all on public.application_attempts from authenticated;

-- Candidate-facing read surface (PRD §18.1 "Applications" /
-- §18.2-adjacent status tracking), transitively owned through
-- application_plans.candidate_id since this table has no direct
-- candidate_id column of its own. No mutation grant for authenticated —
-- attempts are entirely worker-driven.
grant select on public.application_attempts to authenticated;
grant select, insert, update, delete on public.application_attempts to service_role;

create policy "application_attempts_select_own"
  on public.application_attempts
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.application_plans ap
      where ap.id = application_attempts.application_plan_id
        and ap.candidate_id = (select auth.uid())
    )
  );
