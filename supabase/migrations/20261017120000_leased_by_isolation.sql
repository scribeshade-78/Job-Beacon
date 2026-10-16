-- leased_by: TWO EXECUTORS, TWO KINDS OF LEASE.
--
-- THE BUG THIS CLOSES. claim_application_attempt reclaims an attempt whose status is 'leased'
-- and whose leased_until has passed. The browser extension leases an attempt while a HUMAN
-- fills and reviews the form, for 15 minutes. A careful candidate takes longer than that, so the
-- lease expired underneath them and the unattended worker could claim the SAME attempt and
-- submit it through the ATS API - while the browser was submitting it too. Two real applications
-- to one employer, from a race decided by how long somebody read a form.
--
-- WHY NOT JUST A LONGER TIMEOUT. There is no single number that works. Long enough to protect a
-- human (hours) is long enough to strand an attempt whose tab was closed; short enough to
-- recover promptly is short enough to cannibalize a live fill. The two leases are different
-- KINDS of thing - a machine heartbeat and a human deliberation - so they are now different
-- values, and the worker's claim predicate refuses the second kind at ANY age.

alter table public.application_attempts
  add column if not exists leased_by text not null default 'worker';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'application_attempts_leased_by_check'
  ) then
    alter table public.application_attempts
      add constraint application_attempts_leased_by_check
      check (leased_by in ('worker', 'extension'));
  end if;
end
$$;

comment on column public.application_attempts.leased_by is
  'Which executor holds the lease: worker (unattended, reclaimable on expiry) or extension (human-paced, never reclaimed by the worker). Written by claim_application_attempt and claimFillForExtension.';

create or replace function public.claim_application_attempt()
 returns setof application_attempts
 language plpgsql
as $function$
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

  -- ABANDONED EXTENSION LEASE RELEASE.
  --
  -- AN EXTENSION LEASE IS NEVER RECLAIMED BY THE WORKER, so without this an attempt whose tab
  -- was closed mid-fill would sit 'leased' forever: not claimable by the worker, and holding a
  -- live lease_token that refuses the extension too. The candidate would lose the attempt with
  -- no way back.
  --
  -- IT RETURNS TO 'pending_review', NOT 'pending'. This is the safety-critical half of this
  -- migration: for a candidate who waived review, initialAttemptStatusFor writes 'pending', and
  -- the unattended worker may claim 'pending'. Handing an abandoned HUMAN-PACED fill to the
  -- unattended worker would bypass the review the candidate asked for - and would re-open the
  -- very race this migration closes, one step later. 'pending_review' is claimable by the
  -- extension (which accepts both) and by nothing unattended.
  --
  -- TWENTY-FOUR HOURS: long past any plausible form-filling session, short enough that a
  -- candidate finds the attempt again the next day rather than never.
  update public.application_attempts
  set status = 'pending_review',
      leased_by = 'worker',
      lease_token = null,
      leased_until = null,
      updated_at = now()
  where status = 'leased'
    and leased_by = 'extension'
    and (leased_until is null or leased_until < now() - interval '24 hours');

  -- ALLOWLIST. Do not add a status here without deciding, explicitly, whether
  -- unattended automation may dispatch it.
  --
  -- leased_by = 'worker' IS THE ISOLATION. An extension lease is excluded at every age, so this
  -- no longer depends on the two timeouts being related in any way.
  select id into claimed_id
  from public.application_attempts
  where (
      status = 'pending'
      or (status = 'leased' and leased_by = 'worker' and leased_until < now())
    )
    and attempts < max_attempts
  order by created_at
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.application_attempts
  set status = 'leased',
      leased_by = 'worker',
      leased_until = now() + interval '5 minutes',
      lease_token = gen_random_uuid(),
      attempts = attempts + 1,
      updated_at = now()
  where id = claimed_id;

  return query select * from public.application_attempts where id = claimed_id;
end;
$function$;
