-- ===========================================================================
-- Settings the async intake-refresh queue (Step 5 of the async transition).
--
-- WHY A SEPARATE TABLE RATHER THAN REUSING ingestion_jobs.
-- ingestion_jobs is TARGET-scoped: a row names a vacancy_source (one employer board) and
-- nothing else. An intake refresh is CANDIDATE-scoped: it asks "fetch me jobs matching MY
-- keywords, in MY location, in MY markets", and the answer depends on who is asking. There
-- is no column in ingestion_jobs for a candidate, and adding one would give the table two
-- incompatible meanings - a target poll and a personal search would share a queue, a lease
-- and a retry budget while behaving differently in every other respect.
--
-- This mirrors fit_analysis_jobs (20260831120020) instead, which is already the
-- candidate-scoped lease queue in this codebase: same status/attempts/leased_until/
-- dead-letter shape, same FOR UPDATE SKIP LOCKED claim RPC.
--
-- WHY THE REQUEST PARAMS ARE STORED BUT THE PROFILE CONTEXT IS NOT.
-- runIntakeAcrossSources needs keywords, location, country and countries, and those come
-- from loadIntakeQueryContext() reading the candidate's own profile. They are NOT copied
-- into the row: a queued refresh should use the candidate's CURRENT profile when it runs,
-- not the profile as it was when they pressed the button minutes ago. What IS stored is
-- what only the request knows - which sources, an explicit search override, and a row cap.
--
-- ONE ACTIVE REFRESH PER CANDIDATE, ENFORCED BY THE DATABASE. Two presses in quick
-- succession must not run two identical fan-outs, for the same reason the ingestion runner
-- refuses to stack a second job on a target that already has one. A partial unique index
-- says that once, rather than trusting every future caller to check first. It is partial so
-- that finished rows do not block the next refresh.
-- ===========================================================================
create table public.intake_refresh_jobs (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,

  -- Empty array means "every registered intake source", matching the route's behaviour
  -- when the client sends no sourceCode.
  source_codes text[] not null default '{}',
  -- Optional explicit search string; NULL means "use the candidate's own keywords".
  search text,
  row_limit integer check (row_limit is null or row_limit > 0),

  status text not null default 'pending' check (status in ('pending', 'leased', 'done', 'failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  leased_until timestamptz,
  last_error text,
  -- The summary the route used to return synchronously, so the UI can report what a
  -- finished refresh actually found instead of only that it stopped running.
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one queued or in-flight refresh per candidate. Partial, so done/failed rows are
-- history rather than a permanent block.
create unique index intake_refresh_jobs_active_per_candidate_idx
  on public.intake_refresh_jobs (candidate_id)
  where status in ('pending', 'leased');

-- Supports the claim RPC's WHERE status = 'pending' OR (status = 'leased' AND leased_until < now()).
create index intake_refresh_jobs_status_leased_until_idx
  on public.intake_refresh_jobs (status, leased_until);

alter table public.intake_refresh_jobs enable row level security;

revoke all on public.intake_refresh_jobs from public;
revoke all on public.intake_refresh_jobs from anon;
revoke all on public.intake_refresh_jobs from authenticated;

-- Internal worker state, same as ingestion_jobs and fit_analysis_jobs: the candidate sees
-- the vacancies a refresh produced, never the queue row that produced them.
grant select, insert, update, delete on public.intake_refresh_jobs to service_role;

-- Atomic claim-and-lease. A deliberate copy of claim_fit_analysis_job()'s body rather than
-- a shared helper: supabase-js cannot express FOR UPDATE SKIP LOCKED, so each queue carries
-- its own RPC, and the duplication is one short function against one table.
create function public.claim_intake_refresh_job()
returns setof public.intake_refresh_jobs
language plpgsql
as $$
declare
  claimed_id uuid;
begin
  select id into claimed_id
  from public.intake_refresh_jobs
  where (status = 'pending' or (status = 'leased' and leased_until < now()))
    and attempts < max_attempts
  order by created_at
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.intake_refresh_jobs
  set status = 'leased',
      leased_until = now() + interval '5 minutes',
      attempts = attempts + 1,
      updated_at = now()
  where id = claimed_id;

  return query select * from public.intake_refresh_jobs where id = claimed_id;
end;
$$;

revoke all on function public.claim_intake_refresh_job() from public;
revoke all on function public.claim_intake_refresh_job() from anon;
revoke all on function public.claim_intake_refresh_job() from authenticated;
grant execute on function public.claim_intake_refresh_job() to service_role;
