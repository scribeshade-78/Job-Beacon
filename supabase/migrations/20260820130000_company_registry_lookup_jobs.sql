-- MCA registry lookup lease queue (R5.7; PRD §23 "Queue/leasing layer").
-- Exact structural mirror of ingestion_jobs (R2) — same FOR UPDATE SKIP
-- LOCKED claim query, same 5-minute lease window, same status vocabulary
-- ('pending', 'leased', 'done', 'failed') — this is a single external
-- API fetch per job with no multi-step lifecycle, the same shape as an
-- ingestion job, not application_attempts' richer states (no
-- 'action_required' concept applies to a registry lookup).
--
-- Nothing in this repository populates this queue automatically — a row
-- only exists once something already knows a company's CIN. R5.6/R5.7
-- explicitly do not solve CIN discovery (name-search or fuzzy-matching
-- against MCA); rows are inserted by service_role only, today that means
-- an ops script or a manual insert. This table's job is leasing and
-- retrying a known (company_id, cin) pair, not finding one.
create table public.company_registry_lookup_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  cin text not null,

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
create index company_registry_lookup_jobs_status_leased_until_idx
  on public.company_registry_lookup_jobs (status, leased_until);

alter table public.company_registry_lookup_jobs enable row level security;

revoke all on public.company_registry_lookup_jobs from public;
revoke all on public.company_registry_lookup_jobs from anon;
revoke all on public.company_registry_lookup_jobs from authenticated;

-- Internal worker state — not candidate-facing, same as ingestion_jobs.
grant select, insert, update, delete on public.company_registry_lookup_jobs to service_role;

-- Atomic claim-and-lease. supabase-js's REST query builder can't express
-- FOR UPDATE SKIP LOCKED directly, so this is exposed as an RPC instead.
-- SECURITY INVOKER (the default — not DEFINER): the caller's own
-- privileges apply, no reason to run as the function owner here, since
-- only service_role (which already bypasses RLS on this table) is
-- granted EXECUTE below.
create function public.claim_company_registry_lookup_job()
returns setof public.company_registry_lookup_jobs
language plpgsql
as $$
declare
  claimed_id uuid;
begin
  select id into claimed_id
  from public.company_registry_lookup_jobs
  where (status = 'pending' or (status = 'leased' and leased_until < now()))
    and attempts < max_attempts
  order by created_at
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.company_registry_lookup_jobs
  set status = 'leased',
      leased_until = now() + interval '5 minutes',
      attempts = attempts + 1,
      updated_at = now()
  where id = claimed_id;

  return query select * from public.company_registry_lookup_jobs where id = claimed_id;
end;
$$;

revoke all on function public.claim_company_registry_lookup_job() from public;
revoke all on function public.claim_company_registry_lookup_job() from anon;
revoke all on function public.claim_company_registry_lookup_job() from authenticated;
grant execute on function public.claim_company_registry_lookup_job() to service_role;
