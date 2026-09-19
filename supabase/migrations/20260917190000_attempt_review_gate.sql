-- Task U: enforce the review-before-submit gate the UI already promises.
--
-- THE GAP THIS CLOSES. candidate_profiles.review_before_submit has existed
-- since 20260917140000 and the Profile page renders it as "Review before
-- submit — On: you review each application before it is submitted". Nothing
-- read it. planApplication created every attempt as 'pending', and
-- claim_application_attempt claims anything 'pending', so a worker could
-- dispatch an application the candidate believed they would get to look at
-- first. The UI was making a promise the execution engine did not keep.
--
-- That was merely wrong before; with tailored resumes it is worse. The
-- candidate is now told their resume is rewritten per role, which is exactly
-- the thing a person wants to read before it goes to an employer.

-- ---------------------------------------------------------------------------
-- STATE MACHINE: a new status, not a boolean flag.
--
-- WHY NOT an approved_for_submission boolean. A flag would leave the row
-- looking 'pending' — i.e. identical to "ready to dispatch" — while a second
-- column quietly said otherwise. Every existing reader of status, including
-- the claim query itself, would have to learn about the flag or silently get
-- it wrong; a status the claim query does not recognise is wrong by
-- construction instead of wrong by omission. It also gives the candidate
-- something to list ("3 applications awaiting your review") without inventing
-- a second, derived notion of "held".
--
-- The value is a HOLD, not a failure and not a cancellation: nothing has gone
-- wrong, and the attempt is still expected to be submitted. It is also not
-- 'action_required', which means something specific in this schema — a PRD
-- §17 portal exception (CAPTCHA, OTP) with an action_required_events row and
-- an expiry. This needs neither: the action is a plain approval, it never
-- expires, and it is the candidate's routine path rather than an exception.
-- ---------------------------------------------------------------------------
alter table public.application_attempts
  drop constraint if exists application_attempts_status_check;

alter table public.application_attempts
  add constraint application_attempts_status_check
  check (status in (
    'pending',
    'pending_review',
    'leased',
    'succeeded',
    'failed',
    'action_required',
    'cancelled'
  ));

-- WHEN the hold was released, for the audit trail. Deliberately NOT who:
-- the approval route authenticates with WORKER_TRIGGER_SECRET rather than a
-- user session, so there is no candidate identity to record — writing an
-- approver column the endpoint cannot honestly populate would be worse than
-- not having one. A candidate-facing approval route (the next step, see the
-- summary) would add that identity properly.
alter table public.application_attempts
  add column review_approved_at timestamptz;

comment on column public.application_attempts.status is
  'pending = claimable by the worker. pending_review = held for the candidate approval (candidate_profiles.review_before_submit was true at enqueue time); never claimable until approved.';

comment on column public.application_attempts.review_approved_at is
  'When a pending_review attempt was released to the queue. NULL for every attempt that was never held.';

-- The review queue is "this candidate's held attempts, oldest first", and the
-- partial index is exactly that — a full-table index on a status column would
-- be almost entirely 'succeeded' rows nothing looks up.
create index application_attempts_pending_review_idx
  on public.application_attempts (created_at)
  where status = 'pending_review';

-- ---------------------------------------------------------------------------
-- Two changes to claim_application_attempt, and one deliberate non-change.
--
-- THE NON-CHANGE IS THE ENFORCEMENT. The leasing query is an ALLOWLIST
-- (status = 'pending', or a 'leased' row whose lease has expired). A
-- 'pending_review' row matches neither clause, so no worker can claim one —
-- not the daemon, not the HTTP /api/worker/run trigger, not the
-- worker:applications npm script. No predicate was added to say so, because a
-- redundant "and status <> 'pending_review'" is a second place the rule
-- lives, free to drift from the status list above; the allowlist makes the
-- exclusion structural. The pgTAP suite asserts the behaviour rather than
-- trusting a reading of the query (application_attempts_worker.test.sql).
--
-- CHANGE 1: the cancellation sweep must also cover held attempts. Otherwise a
-- candidate who pauses automation while three applications sit in their review
-- queue keeps three rows that look like live work, and approving one later
-- would move it to 'pending' — where the sweep would then, correctly, cancel
-- it. Cancelling them here instead means the review queue never shows work
-- that can no longer happen.
--
-- CHANGE 2: the sweep's WHERE clause is rewritten as an explicit or-list
-- rather than the two-clause shape it had. The original spelled out
-- (status = 'pending' or (status = 'leased' and leased_until < now())) — which
-- is "the claimable set" — and adding a third status to an or-chain is where
-- that kind of expression stops being readable. Both clauses are still
-- separately meaningful, so both are kept, each on its own line.
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
