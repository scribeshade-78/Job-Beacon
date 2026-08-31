-- Response Intelligence Phase 2.1 — fit-analysis work queue.
--
-- Minimal Postgres-backed lease queue, the same shape as ingestion_jobs
-- (20260813205354) and claim_ingestion_job(): status / attempts /
-- leased_until / dead-letter, plus a claim RPC using FOR UPDATE SKIP
-- LOCKED (supabase-js can't express that directly). A fit computation is a
-- fan-out unit of work (one per candidate x vacancy) with its own
-- retry/backoff needs, so it takes a real queue rather than the
-- scan-for-unprocessed-rows pattern the Phase 1/3 mailbox workers use.
--
-- One row per (candidate, vacancy) pair ever: enqueue does ON CONFLICT DO
-- UPDATE SET status='pending', attempts=0 to re-arm an existing done/failed
-- row when a re-analysis is wanted (facts confirmed, vacancy re-verified).
create table public.fit_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,
  vacancy_id uuid not null references public.vacancies (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'leased', 'done', 'failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  leased_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (candidate_id, vacancy_id)
);

-- Supports claim_fit_analysis_job()'s WHERE status = 'pending' OR (status
-- = 'leased' AND leased_until < now()).
create index fit_analysis_jobs_status_leased_until_idx on public.fit_analysis_jobs (status, leased_until);

alter table public.fit_analysis_jobs enable row level security;

revoke all on public.fit_analysis_jobs from public;
revoke all on public.fit_analysis_jobs from anon;
revoke all on public.fit_analysis_jobs from authenticated;

-- Internal worker state — not candidate-facing (same as ingestion_jobs).
grant select, insert, update, delete on public.fit_analysis_jobs to service_role;

-- Atomic claim-and-lease — a copy of claim_ingestion_job()'s body. SECURITY
-- INVOKER (the default): only service_role (which bypasses RLS on this
-- table) is granted EXECUTE.
create function public.claim_fit_analysis_job()
returns setof public.fit_analysis_jobs
language plpgsql
as $$
declare
  claimed_id uuid;
begin
  select id into claimed_id
  from public.fit_analysis_jobs
  where (status = 'pending' or (status = 'leased' and leased_until < now()))
    and attempts < max_attempts
  order by created_at
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.fit_analysis_jobs
  set status = 'leased',
      leased_until = now() + interval '5 minutes',
      attempts = attempts + 1,
      updated_at = now()
  where id = claimed_id;

  return query select * from public.fit_analysis_jobs where id = claimed_id;
end;
$$;

revoke all on function public.claim_fit_analysis_job() from public;
revoke all on function public.claim_fit_analysis_job() from anon;
revoke all on function public.claim_fit_analysis_job() from authenticated;
grant execute on function public.claim_fit_analysis_job() to service_role;

-- Enqueue-on-fact-confirmed. fact_confirmations is written browser-side via
-- an RLS UPDATE (no server code runs on confirm), so this is a DB trigger
-- rather than an Express hook — the same "trigger enforces the invariant
-- universally, including outside RLS" reasoning as
-- enforce_appeal_reviewer_separation. SECURITY DEFINER because the
-- `authenticated` role performing the confirmation has no grant on
-- fit_analysis_jobs; search_path is pinned per the SECURITY DEFINER
-- convention.
--
-- ponytail: fan-out inside a trigger, bounded by the count of currently
-- VERIFIED/VERIFIED_INCOMPLETE vacancies — acceptable at pre-launch
-- volume; revisit (batch enqueue, or a reconcile pass in worker:fit) if
-- that count grows large.
create function public.fit_enqueue_on_fact_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_candidate_id uuid;
begin
  select ef.candidate_id into owner_candidate_id
  from public.extracted_facts ef
  where ef.id = new.extracted_fact_id;

  if owner_candidate_id is null then
    return new;
  end if;

  insert into public.fit_analysis_jobs (candidate_id, vacancy_id)
  select owner_candidate_id, v.id
  from public.vacancies v
  where v.trust_status in ('VERIFIED', 'VERIFIED_INCOMPLETE')
  on conflict (candidate_id, vacancy_id)
  do update set status = 'pending', attempts = 0, last_error = null, updated_at = now();

  return new;
end;
$$;

create trigger fit_enqueue_on_fact_confirmed_trigger
  after update on public.fact_confirmations
  for each row
  when (new.status = 'confirmed' and old.status is distinct from 'confirmed')
  execute function public.fit_enqueue_on_fact_confirmed();
