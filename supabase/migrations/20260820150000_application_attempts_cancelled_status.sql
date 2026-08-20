-- R7-M4: candidate authorization withdrawal (pause/stop) must be effective
-- at execution time, not just at application_plans' one-time gate
-- evaluation (R4.1/R4.2's "gate_results is frozen at creation time"
-- design). None of the five existing application_attempts.status values
-- honestly represent "the candidate withdrew consent, so this attempt
-- will never be submitted": 'succeeded' is obviously wrong; 'failed'
-- would misrepresent an intentional candidate action as a system failure
-- (application_attempts is rendered raw to the candidate in the
-- Applications panel); 'action_required' requires a PRD §17 exception_type
-- and a candidate action to resume, neither of which applies here — the
-- candidate already acted, and nothing they do "resolves" a withdrawal
-- except re-authorizing, which is automation_authorizations' own concern,
-- not this attempt's. 'cancelled' is a new, honest terminal state, and
-- PRD §13.2's moderator workflow already uses the same word for the same
-- shape of event ("Affected pending applications cancelled or released").
alter table public.application_attempts
  drop constraint if exists application_attempts_status_check;

alter table public.application_attempts
  add constraint application_attempts_status_check
  check (status in (
    'pending',
    'leased',
    'succeeded',
    'failed',
    'action_required',
    'cancelled'
  ));

-- Primary safety boundary: cancel any currently-claimable attempt
-- (mirroring the leasing query's own claimable-set definition exactly)
-- belonging to a candidate who is not currently authorized, before the
-- leasing query ever runs. A row cancelled here was never leased, so
-- attempts/leased_until are never touched for it — no compensating
-- mutation is needed, because none was ever made. "Not authorized" is
-- checked as the absence of an authorized row (not an explicit
-- paused/stopped list) to match evaluateAutomationAuthorization's own
-- fail-safe default in eligibilityGate.ts exactly (missing row = not
-- authorized) — though by the time an attempt exists, an authorized row
-- must have existed at plan-creation time (planApplication only creates
-- attempts when the automation_authorization gate already passed), so the
-- missing-row case is defensive, not expected to occur.
--
-- This closes the race for every candidate who paused/stopped before this
-- function call runs. It does not, and cannot, protect the narrow window
-- where a worker has already leased a row and moved on to
-- submitApplicationAttempt when a pause/stop lands microseconds later —
-- that remaining window is closed (as far as this architecture allows) by
-- a second, application-code-level check immediately before
-- adapter.submit() is called (see submissionAdapter.ts), not by this
-- function. True atomicity across an external HTTP submission call is not
-- achievable without holding a database transaction open across that
-- call, which the existing 5-minute-lease design deliberately avoids.
create or replace function public.claim_application_attempt()
returns setof public.application_attempts
language plpgsql
as $$
declare
  claimed_id uuid;
begin
  update public.application_attempts aa
  set status = 'cancelled',
      updated_at = now()
  from public.application_plans ap
  where aa.application_plan_id = ap.id
    and (aa.status = 'pending' or (aa.status = 'leased' and aa.leased_until < now()))
    and not exists (
      select 1
      from public.automation_authorizations auth
      where auth.candidate_id = ap.candidate_id
        and auth.status = 'authorized'
    );

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
      attempts = attempts + 1,
      updated_at = now()
  where id = claimed_id;

  return query select * from public.application_attempts where id = claimed_id;
end;
$$;

-- CREATE OR REPLACE FUNCTION preserves prior grants on the same function
-- object, but re-asserting them explicitly matches this repository's
-- existing defense-in-depth style (e.g. every migration re-revokes from
-- public/anon/authenticated even where nothing granted them anything to
-- begin with).
revoke all on function public.claim_application_attempt() from public;
revoke all on function public.claim_application_attempt() from anon;
revoke all on function public.claim_application_attempt() from authenticated;
grant execute on function public.claim_application_attempt() to service_role;
