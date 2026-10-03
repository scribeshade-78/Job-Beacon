-- Batch A follow-up — prove LEASE OWNERSHIP, not just lease validity.
--
-- THE HOLE. 20261001140000 moved the attempt to 'submitting' with a predicate of
-- status='leased' AND leased_until > now(). Neither term identifies WHICH worker
-- holds the lease. Claim is FOR UPDATE SKIP LOCKED, so two workers never hold the
-- same lease at the same instant — but a stale worker whose lease expired, and
-- whose row was then re-leased to someone else, still satisfies "status='leased'
-- and leased_until in the future". It would cross the boundary on the NEW
-- worker's lease and submit a second time.
--
-- THE FIX, in two parts.
--
-- 1. lease_token: an unguessable value minted by the claim and returned to the
--    worker that received it. Only the holder can present it.
--
-- 2. begin_application_submission(): the boundary becomes an atomic database
--    operation, so ownership and expiry are evaluated against DATABASE time in
--    the same statement as the transition. Comparing leased_until against a
--    client-supplied timestamp (what the previous version did) trusts the
--    worker's clock, which is the thing that just expired.
--
-- Both are additive to 20261001140000: that migration's status CHECK, trigger and
-- backfill are unchanged and still required.
alter table public.application_attempts
  add column lease_token uuid;

comment on column public.application_attempts.lease_token is
  'Fencing token minted by claim_application_attempt() for the worker that received the lease. The submission boundary requires it, so a worker whose lease expired and was re-leased to someone else cannot cross on the new holder''s lease.';

-- The claim now mints a fresh token on every lease, so a stale worker's token
-- can never match a later lease.
create or replace function public.claim_application_attempt()
returns setof public.application_attempts
language plpgsql
as $$
declare
  claimed_id uuid;
begin
  select id into claimed_id
  from public.application_attempts
  where (status = 'pending' or (status = 'leased' and leased_until < now()))
    and attempts < max_attempts
  order by created_at
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.application_attempts
  set status = 'leased',
      leased_until = now() + interval '5 minutes',
      lease_token = gen_random_uuid(),
      attempts = attempts + 1,
      updated_at = now()
  where id = claimed_id;

  return query select * from public.application_attempts where id = claimed_id;
end;
$$;

-- SECURITY INVOKER (the default), like the claim: only service_role is granted
-- EXECUTE, and it already bypasses RLS on this table. A candidate holding a
-- session cannot reach it, and cannot forge acceptance by crossing the boundary.
create or replace function public.begin_application_submission(
  p_attempt_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
as $$
declare
  crossed boolean;
begin
  update public.application_attempts
  set status = 'submitting',
      submission_started_at = now(),
      updated_at = now()
  where id = p_attempt_id
    and status = 'leased'
    and leased_until > now()
    and lease_token = p_lease_token
  returning true into crossed;

  return coalesce(crossed, false);
end;
$$;

revoke all on function public.begin_application_submission(uuid, uuid) from public;
revoke all on function public.begin_application_submission(uuid, uuid) from anon;
revoke all on function public.begin_application_submission(uuid, uuid) from authenticated;
grant execute on function public.begin_application_submission(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here, and they are NOT a substitute for a
-- database test. Run against a disposable local instance.
--
-- 1. Fencing works (run as service_role, in a transaction you roll back):
--      select id, lease_token from public.claim_application_attempt();  -- token A
--      -- simulate expiry + a new holder:
--      update public.application_attempts
--        set status='leased', leased_until = now() + interval '5 minutes',
--            lease_token = gen_random_uuid()
--        where id = '<id>';
--      select public.begin_application_submission('<id>', '<token A>');  -- expect FALSE
--
-- 2. Expiry is judged on DATABASE time:
--      -- after the row's leased_until has passed:
--      select public.begin_application_submission('<id>', '<current token>'); -- expect FALSE
--
-- 3. Ownership is required, not inherited:
--      select public.begin_application_submission('<id>', null);  -- expect FALSE
--
-- DEPLOYMENT ORDERING — MIGRATION FIRST, THEN WORKER. worker.ts calls
-- begin_application_submission() and reads lease_token. Against a database that
-- has not run this migration, the RPC does not exist: the claim returns rows with
-- no lease_token, and the boundary call errors. worker.ts treats a boundary error
-- as fatal (it throws) and therefore makes ZERO adapter calls — a loud failure
-- rather than a silent unprotected submission. That is the intended failure mode,
-- and it is why this migration must be applied before the worker image ships.
-- ---------------------------------------------------------------------------
