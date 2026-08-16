-- Minimal Postgres-backed lease queue (PRD §23 "Queue/leasing layer:
-- PostgreSQL-backed tasks, leases, retries and dead-letter handling").
--
-- pg-boss was considered and NOT adopted for R2: the jobbeacon-development
-- skill requires a compatibility spike (schema permissions, pooled vs
-- direct connections, migrations, lease/restart recovery) before adopting
-- it, and explicitly documents "a minimal Postgres queue based on leases
-- and FOR UPDATE SKIP LOCKED" as the fallback when it isn't justified.
-- R2's actual load — a handful of sources, foundation-phase, no
-- production deployment yet — doesn't need pg-boss's retry/backoff
-- sophistication, and adopting a new dependency (plus its own schema
-- surface) just to immediately not rely on most of it would be the
-- opposite of minimal. This table plus FOR UPDATE SKIP LOCKED is that
-- fallback, not an unjustified custom build.
--
-- One job per (source_code, vacancy_source_id) fetch attempt. Idempotency
-- doesn't need a separate key column here: the actual write is idempotent
-- via vacancies' own (source_code, source_vacancy_id) unique constraint
-- (upsert-on-conflict), so double-processing the same fetch is harmless —
-- this queue only needs to prevent *concurrent* double-leasing, which the
-- lease mechanism itself handles.
create table public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  source_code text not null references public.source_policies (source_code),
  vacancy_source_id uuid not null references public.vacancy_sources (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'leased', 'done', 'failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  leased_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Supports the worker's SELECT ... FOR UPDATE SKIP LOCKED WHERE status =
-- 'pending' OR (status = 'leased' AND leased_until < now()) query.
create index ingestion_jobs_status_leased_until_idx on public.ingestion_jobs (status, leased_until);

alter table public.ingestion_jobs enable row level security;

revoke all on public.ingestion_jobs from public;
revoke all on public.ingestion_jobs from anon;
revoke all on public.ingestion_jobs from authenticated;

-- Internal worker state — not candidate-facing.
grant select, insert, update, delete on public.ingestion_jobs to service_role;

-- Atomic claim-and-lease. supabase-js's REST query builder can't express
-- FOR UPDATE SKIP LOCKED directly, so this is exposed as an RPC instead.
-- SECURITY INVOKER (the default — not DEFINER): the caller's own
-- privileges apply, no reason to run as the function owner here, since
-- only service_role (which already bypasses RLS on ingestion_jobs) is
-- granted EXECUTE below.
create function public.claim_ingestion_job()
returns setof public.ingestion_jobs
language plpgsql
as $$
declare
  claimed_id uuid;
begin
  select id into claimed_id
  from public.ingestion_jobs
  where (status = 'pending' or (status = 'leased' and leased_until < now()))
    and attempts < max_attempts
  order by created_at
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.ingestion_jobs
  set status = 'leased',
      leased_until = now() + interval '5 minutes',
      attempts = attempts + 1,
      updated_at = now()
  where id = claimed_id;

  return query select * from public.ingestion_jobs where id = claimed_id;
end;
$$;

revoke all on function public.claim_ingestion_job() from public;
revoke all on function public.claim_ingestion_job() from anon;
revoke all on function public.claim_ingestion_job() from authenticated;
grant execute on function public.claim_ingestion_job() to service_role;
