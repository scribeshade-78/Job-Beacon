-- Batch A follow-up — RESTORE the cancellation sweep that 20261001160000 dropped.
--
-- THE REGRESSION. 20260917190000_attempt_review_gate.sql added a cancellation
-- sweep to claim_application_attempt(): before anything is leased, every
-- claimable attempt whose candidate is not 'authorized' is moved to 'cancelled'.
-- That is what stops work being dispatched on behalf of a candidate who paused or
-- stopped automation, and it keeps their review queue from showing work that can
-- no longer happen (the sweep covers 'pending_review' too, deliberately).
--
-- 20261001160000_application_submission_fencing.sql then re-created the whole
-- function to mint lease_token, and its body is the plain FIFO lease query with
-- the sweep absent. That migration's own header describes only lease ownership;
-- it says nothing about retiring the sweep, and
-- application_attempts_worker.test.sql (tests 10-13, 22-23) still asserts the
-- sweep's behaviour. So the sweep was LOST, not retired: after 20261001160000 a
-- paused or stopped candidate's pending attempt is leased and submitted.
--
-- WHAT THIS DOES. Re-creates the function with BOTH behaviours — the sweep, and a
-- fresh lease_token on every lease. No other change. This is append-only: the
-- already-applied 20261001160000 is left in place, and production databases that
-- have it get the sweep back by applying this file.
create or replace function public.claim_application_attempt()
returns setof public.application_attempts
language plpgsql
as $$
declare
  claimed_id uuid;
begin
  -- CANCELLATION SWEEP. Not authorized is the common case for a candidate who
  -- has never granted consent, so this is an "is not authorized" test rather
  -- than an enumeration of the not-authorized statuses.
  update public.application_attempts aa
  set status = 'cancelled',
      updated_at = now()
  from public.application_plans ap
  where aa.application_plan_id = ap.id
    and (
      aa.status = 'pending'
      or aa.status = 'pending_review'
      or (aa.status = 'leased' and aa.leased_until < now())
    )
    and not exists (
      select 1
      from public.automation_authorizations auth
      where auth.candidate_id = ap.candidate_id
        and auth.status = 'authorized'
    );

  -- ALLOWLIST. Do not add a status here without deciding, explicitly, whether
  -- unattended automation may dispatch it.
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

revoke all on function public.claim_application_attempt() from public;
revoke all on function public.claim_application_attempt() from anon;
revoke all on function public.claim_application_attempt() from authenticated;
grant execute on function public.claim_application_attempt() to service_role;

comment on function public.claim_application_attempt() is
  'Service-role leasing for application attempts: cancels every claimable attempt whose candidate is not authorized, then leases the oldest claimable attempt (FIFO by created_at) with a fresh lease_token, incrementing attempts. The sweep is the guard that no work is dispatched for a paused or stopped candidate.';

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here; NOT database tests. The executable
-- fixture is supabase/tests/database/application_attempts_worker.test.sql.
--
-- 1. The sweep is present and selective (run as service_role, rolled back):
--      -- one attempt each for an authorized, a paused and a stopped candidate
--      select id, status from public.claim_application_attempt();
--      -- expect the authorized candidate's attempt leased,
--      -- and the other two 'cancelled' with attempts = 0
--
-- 2. The fencing token is still minted:
--      select lease_token is not null from public.claim_application_attempt();
--
-- 3. authenticated/anon still cannot execute:
--      -- as authenticated, select public.claim_application_attempt(); expect 42501
--
-- ROLLBACK
--   Re-apply the 20261001160000 body (lease_token, no sweep) to restore the
--   previous behaviour. Note that rolling this back REINTRODUCES the regression:
--   attempts for paused and stopped candidates become leaseable again.
-- ---------------------------------------------------------------------------
