-- D1-RANK-REFRESH — the manual feed-ranking refresh workflow state.
--
-- WHY THIS EXISTS. The derived ranking data (posting evidence tokens, candidate
-- qualifier generations, candidate role matches) is produced by three existing
-- functions that had NO production caller: indexVacancyEvidence and
-- refreshCandidateQualifierTokens were reachable only from tests, and
-- materializeCandidateRoleMatches only from an operator CLI. A signed-in
-- candidate's feed therefore sat in "updating" until an operator intervened.
--
-- This migration adds ONLY the durable, shared state the authenticated refresh
-- route needs to run that workflow without a daemon or cron:
--
--   * posting_evidence_index_state — ONE singleton row for the SHARED posting
--     index. Its positional cursor is persisted so a sweep of a large corpus
--     continues across bounded requests, and its lease means exactly one request
--     indexes at a time; every candidate benefits from the same work.
--
--   * candidate_ranking_refresh — ONE row per candidate tracking the refresh
--     lifecycle (pending / running / succeeded / failed), its lease, attempts and
--     last error, so "preference saved" is distinguishable from "ranking refresh
--     pending" and from "refresh failed and is retryable".
--
-- NOTHING HERE MATCHES POSTINGS, TOKENS OR ROLES. The authoritative TypeScript
-- matcher and tokenizer remain the only implementations; this migration only
-- coordinates their callers and bounds concurrency.
--
-- NO CANDIDATE WRITES. Both tables are service-role written; a candidate may only
-- SELECT its own refresh row, and no candidate can start, lease or forge work.

-- ---------------------------------------------------------------------------
-- 1. Global posting-evidence index state (singleton).
-- ---------------------------------------------------------------------------
create table public.posting_evidence_index_state (
  id boolean primary key default true check (id),

  status text not null default 'idle' check (status in ('idle', 'running', 'succeeded', 'failed')),

  -- Vacancies already examined in the CURRENT sweep. Reset to 0 when a sweep
  -- completes, because a new vacancy can take any uuid and the next sweep must
  -- start from the beginning to see it; re-indexing a current row is skipped.
  cursor_offset integer not null default 0,

  -- Monotonic observability counters across sweeps.
  scanned integer not null default 0,
  indexed integer not null default 0,

  last_error text,
  leased_until timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.posting_evidence_index_state (id) values (true);

alter table public.posting_evidence_index_state enable row level security;

revoke all on public.posting_evidence_index_state from public;
revoke all on public.posting_evidence_index_state from anon;
revoke all on public.posting_evidence_index_state from authenticated;

-- Internal worker coordination. service_role is the only writer, and candidates
-- have no direct read: the workflow result is what they see.
grant select, insert, update, delete on public.posting_evidence_index_state to service_role;

comment on table public.posting_evidence_index_state is
  'Singleton lease + cursor for the SHARED posting-evidence index sweep. One request indexes at a time; the cursor is persisted so a sweep continues across bounded authenticated requests. Reset to 0 on completion because new vacancy ids are unordered.';

-- ---------------------------------------------------------------------------
-- 2. Per-candidate refresh state.
-- ---------------------------------------------------------------------------
create table public.candidate_ranking_refresh (
  candidate_id uuid primary key references public.candidate_profiles (id) on delete cascade,

  status text not null default 'idle' check (status in ('idle', 'pending', 'running', 'succeeded', 'failed')),

  -- Counts FAILURES only, not continuation steps: a long sweep claims the lease
  -- many times without consuming an attempt, while each failed refresh consumes
  -- one, so a poisoned candidate stops after max_attempts until an explicit
  -- retry resets it.
  attempts integer not null default 0,
  max_attempts integer not null default 5,

  last_error text,
  requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  leased_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.candidate_ranking_refresh enable row level security;

revoke all on public.candidate_ranking_refresh from public;
revoke all on public.candidate_ranking_refresh from anon;
revoke all on public.candidate_ranking_refresh from authenticated;

-- Read-your-own only, so a status surface can show pending/running/failed without
-- a server round trip. There is NO candidate write grant: a candidate cannot
-- start, lease, extend or forge a refresh.
grant select on public.candidate_ranking_refresh to authenticated;
grant select, insert, update, delete on public.candidate_ranking_refresh to service_role;

create policy "candidate_ranking_refresh_select_own"
  on public.candidate_ranking_refresh
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);

comment on table public.candidate_ranking_refresh is
  'Per-candidate manual ranking-refresh lifecycle: pending/running/succeeded/failed, lease, failure attempts and last_error. Service-role written by the authenticated refresh route; candidates read only their own row.';

-- ---------------------------------------------------------------------------
-- 3. Refresh lifecycle RPCs (service-role only).
-- ---------------------------------------------------------------------------

-- Request (or re-arm) a refresh. p_force resets a terminal or stale row to
-- pending WITHOUT clobbering a live lease, so a role save cannot interrupt work
-- already in progress and a retry re-arms a failed refresh from a clean slate.
create function public.request_candidate_ranking_refresh(
  p_candidate_id uuid,
  p_force boolean default false
)
returns setof public.candidate_ranking_refresh
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.candidate_ranking_refresh;
  lease_active boolean;
begin
  insert into public.candidate_ranking_refresh (candidate_id, status, requested_at)
  values (p_candidate_id, 'pending', now())
  on conflict (candidate_id) do nothing;

  select * into current_row
  from public.candidate_ranking_refresh
  where candidate_id = p_candidate_id
  for update;

  lease_active := current_row.status = 'running'
    and current_row.leased_until is not null
    and current_row.leased_until > now();

  if p_force and not lease_active then
    update public.candidate_ranking_refresh
    set status = 'pending',
        attempts = 0,
        last_error = null,
        requested_at = now(),
        completed_at = null,
        leased_until = null,
        updated_at = now()
    where candidate_id = p_candidate_id;
  end if;

  return query select * from public.candidate_ranking_refresh where candidate_id = p_candidate_id;
end;
$$;

-- Atomic claim-and-lease. Only 'pending' or an EXPIRED 'running' row is
-- claimable; 'failed' is deliberately NOT, so a broken refresh is not retried by
-- an ordinary poll — only an explicit request(p_force => true) re-arms it.
create function public.claim_candidate_ranking_refresh(
  p_candidate_id uuid,
  p_lease_seconds integer default 30
)
returns setof public.candidate_ranking_refresh
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed uuid;
begin
  select candidate_id into claimed
  from public.candidate_ranking_refresh
  where candidate_id = p_candidate_id
    and (status = 'pending' or (status = 'running' and (leased_until is null or leased_until < now())))
    and attempts < max_attempts
  for update skip locked;

  if claimed is null then
    return;
  end if;

  update public.candidate_ranking_refresh
  set status = 'running',
      leased_until = now() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, now()),
      completed_at = null,
      updated_at = now()
  where candidate_id = claimed;

  return query select * from public.candidate_ranking_refresh where candidate_id = claimed;
end;
$$;

-- Release the lease and record the outcome. 'pending' means "continue on the next
-- bounded request" (never a completed empty derivation); 'failed' increments the
-- failure count and carries the actionable error.
create function public.finish_candidate_ranking_refresh(
  p_candidate_id uuid,
  p_status text,
  p_last_error text default null
)
returns setof public.candidate_ranking_refresh
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.candidate_ranking_refresh
  set status = p_status,
      last_error = p_last_error,
      leased_until = null,
      attempts = case when p_status = 'failed' then attempts + 1 else attempts end,
      completed_at = case when p_status in ('succeeded', 'failed') then now() else null end,
      updated_at = now()
  where candidate_id = p_candidate_id and status = 'running';

  return query select * from public.candidate_ranking_refresh where candidate_id = p_candidate_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Shared posting-index sweep RPCs (service-role only).
-- ---------------------------------------------------------------------------
create function public.claim_posting_evidence_index(
  p_lease_seconds integer default 30
)
returns setof public.posting_evidence_index_state
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean;
begin
  select id into claimed
  from public.posting_evidence_index_state
  where id and (leased_until is null or leased_until < now())
  for update skip locked;

  if claimed is null then
    return;
  end if;

  update public.posting_evidence_index_state
  set status = 'running',
      leased_until = now() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where id;

  return query select * from public.posting_evidence_index_state where id;
end;
$$;

-- Persist the sweep position and release the lease. p_done resets the cursor for
-- the next sweep; a recorded error keeps the cursor so the next request retries
-- the failed rows instead of skipping past them.
create function public.advance_posting_evidence_index(
  p_cursor_offset integer,
  p_done boolean,
  p_scanned integer,
  p_indexed integer,
  p_last_error text default null
)
returns setof public.posting_evidence_index_state
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posting_evidence_index_state
  set cursor_offset = case when p_done then 0 else greatest(coalesce(p_cursor_offset, 0), 0) end,
      status = case
        when p_last_error is not null then 'failed'
        when p_done then 'succeeded'
        else 'idle'
      end,
      scanned = scanned + greatest(coalesce(p_scanned, 0), 0),
      indexed = indexed + greatest(coalesce(p_indexed, 0), 0),
      last_error = p_last_error,
      leased_until = null,
      completed_at = case when p_done then now() else completed_at end,
      updated_at = now()
  where id;

  return query select * from public.posting_evidence_index_state where id;
end;
$$;

revoke all on function public.request_candidate_ranking_refresh(uuid, boolean) from public;
revoke all on function public.request_candidate_ranking_refresh(uuid, boolean) from anon;
revoke all on function public.request_candidate_ranking_refresh(uuid, boolean) from authenticated;
grant execute on function public.request_candidate_ranking_refresh(uuid, boolean) to service_role;

revoke all on function public.claim_candidate_ranking_refresh(uuid, integer) from public;
revoke all on function public.claim_candidate_ranking_refresh(uuid, integer) from anon;
revoke all on function public.claim_candidate_ranking_refresh(uuid, integer) from authenticated;
grant execute on function public.claim_candidate_ranking_refresh(uuid, integer) to service_role;

revoke all on function public.finish_candidate_ranking_refresh(uuid, text, text) from public;
revoke all on function public.finish_candidate_ranking_refresh(uuid, text, text) from anon;
revoke all on function public.finish_candidate_ranking_refresh(uuid, text, text) from authenticated;
grant execute on function public.finish_candidate_ranking_refresh(uuid, text, text) to service_role;

revoke all on function public.claim_posting_evidence_index(integer) from public;
revoke all on function public.claim_posting_evidence_index(integer) from anon;
revoke all on function public.claim_posting_evidence_index(integer) from authenticated;
grant execute on function public.claim_posting_evidence_index(integer) to service_role;

revoke all on function public.advance_posting_evidence_index(integer, boolean, integer, integer, text) from public;
revoke all on function public.advance_posting_evidence_index(integer, boolean, integer, integer, text) from anon;
revoke all on function public.advance_posting_evidence_index(integer, boolean, integer, integer, text) from authenticated;
grant execute on function public.advance_posting_evidence_index(integer, boolean, integer, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here; NOT database tests. The runnable
-- fixtures are supabase/tests/database/feed_ranking_refresh.test.sql and are
-- labelled UNEXECUTED.
--
-- 1. One indexer at a time:
--      select public.claim_posting_evidence_index(30);  -- returns the row
--      select public.claim_posting_evidence_index(30);  -- returns nothing
--
-- 2. A live candidate lease is never clobbered by a request:
--      -- request(force => true) while status='running' and leased_until > now()
--      -- leaves status='running'
--
-- 3. A failed refresh is not auto-retried:
--      -- finish('failed') then claim() returns nothing; only request(force) re-arms
--
-- 4. Cross-candidate: as candidate B, candidate_ranking_refresh returns only B's
--    row and an insert fails with 42501.
--
-- ROLLBACK
--   drop function if exists public.advance_posting_evidence_index(integer, boolean, integer, integer, text);
--   drop function if exists public.claim_posting_evidence_index(integer);
--   drop function if exists public.finish_candidate_ranking_refresh(uuid, text, text);
--   drop function if exists public.claim_candidate_ranking_refresh(uuid, integer);
--   drop function if exists public.request_candidate_ranking_refresh(uuid, boolean);
--   drop table if exists public.candidate_ranking_refresh;
--   drop table if exists public.posting_evidence_index_state;
--   Only coordination state is lost; all derived ranking data is reproducible.
-- ---------------------------------------------------------------------------
