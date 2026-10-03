-- Batch A — a durable submission boundary, and "Applied" that cannot be faked.
--
-- THE DEFECT THIS FIXES. server/applications/worker.ts called the adapter and
-- then wrote application_evidence and status = 'succeeded' WITHOUT checking
-- either error. An awaited PostgREST builder resolves with { error }; it does
-- not throw. So a failed write still left a 'succeeded' row, and
-- shared/pipelineStages.ts classifies any 'succeeded' attempt as Applied.
--
-- THE SECOND DEFECT, WHICH IS WORSE. claim_application_attempt
-- (20260818090000) reclaims rows with (status = 'pending') OR
-- (status = 'leased' AND leased_until < now()). An attempt left 'leased' after
-- an external submission was accepted is therefore RECLAIMED five minutes later
-- and submitted a second time. Writing a post-acceptance marker cannot close
-- that: if the marker write is what fails, the row is still reclaimable. The
-- boundary has to exist BEFORE the adapter is called.
--
-- WHAT THIS MIGRATION ADDS
--
-- 1. 'submitting' — a state that is deliberately EXCLUDED from the claim
--    predicate above, so once a worker has crossed the boundary no ordinary
--    claim can hand the attempt to another worker, however long it takes.
--    Crossing the boundary is a single conditional UPDATE that also validates
--    lease ownership and expiry, so a stale worker cannot cross it at all.
--
-- 2. submission_started_at — when the boundary was crossed. Distinct from
--    updated_at, which moves for unrelated writes (generating a cover letter
--    touches the row), and from succeeded_at, which means something else.
--
-- 3. A trigger making 'succeeded' unreachable without persisted acceptance
--    evidence. "Applied" is a claim about the world, so the database refuses the
--    claim unless the receipt is already stored. A bare status — or a boolean
--    marker that merely repeats it — can no longer produce Applied, and no code
--    change in a future worker can regress that silently.
--
-- WHAT IT DELIBERATELY DOES NOT DO. Nothing here retries an external
-- submission. There is no provider idempotency key in this repository and this
-- migration does not invent one: an attempt whose external outcome is unknown
-- stays 'submitting' and must be resolved by a human or a reconciliation path,
-- never by automatic resubmission.
alter table public.application_attempts
  add column submission_started_at timestamptz;

-- Extend the CHECK in place. The value list below is the CURRENT one
-- (20260917190000_attempt_review_gate.sql) plus 'submitting'; every existing
-- value is preserved, because dropping one would orphan live rows.
alter table public.application_attempts
  drop constraint if exists application_attempts_status_check;

alter table public.application_attempts
  add constraint application_attempts_status_check
  check (status in (
    'pending',
    'pending_review',
    'leased',
    'submitting',
    'succeeded',
    'failed',
    'action_required',
    'cancelled'
  ));

comment on column public.application_attempts.submission_started_at is
  'When this attempt crossed the submission boundary (leased -> submitting). Set BEFORE the adapter is called. Non-null means an external attempt may have begun, so the row must never be returned to the ordinary retry queue automatically.';

-- ---------------------------------------------------------------------------
-- "APPLIED" REQUIRES A STORED RECEIPT.
--
-- The worker now writes application_evidence (evidence_type
-- 'submission_confirmation', payload = the adapter's own confirmation) BEFORE
-- it moves the attempt to 'succeeded', so this trigger passes on the normal
-- path. It fires only when a status write tries to claim acceptance that was
-- never persisted — the exact shape of the original bug.
--
-- 23514 (check_violation) is used deliberately: this is the same class of
-- error as the status CHECK, so an existing caller that already handles a
-- rejected status write handles this one too.
-- ---------------------------------------------------------------------------
create or replace function public.application_attempts_require_acceptance_evidence()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'succeeded' and old.status is distinct from 'succeeded' then
    if not exists (
      select 1
      from public.application_evidence e
      where e.application_attempt_id = new.id
        and e.evidence_type = 'submission_confirmation'
    ) then
      raise exception
        'application_attempts % cannot be marked succeeded without persisted submission confirmation evidence',
        new.id
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists application_attempts_require_acceptance_evidence on public.application_attempts;

create trigger application_attempts_require_acceptance_evidence
  before update on public.application_attempts
  for each row
  execute function public.application_attempts_require_acceptance_evidence();

-- ---------------------------------------------------------------------------
-- HISTORICAL INCONSISTENT RECORDS — DOWNGRADE, NEVER MANUFACTURE.
--
-- Any 'succeeded' row written before this migration that has no stored
-- confirmation is an acceptance claim we cannot verify. It is moved back to
-- 'submitting' — which is excluded from claiming, so it can never be
-- resubmitted — rather than being left as Applied or deleted. No confirmation
-- row is invented for it: a fabricated receipt would be worse than the original
-- bug, because it would be indistinguishable from a real one.
--
-- Rows that DO have a confirmation are left alone.
-- ---------------------------------------------------------------------------
update public.application_attempts a
set status = 'submitting',
    last_error = 'Acceptance recorded before submission_confirmation evidence existed; needs verification.',
    updated_at = now()
where a.status = 'succeeded'
  and a.succeeded_at is not null
  and not exists (
    select 1
    from public.application_evidence e
    where e.application_attempt_id = a.id
      and e.evidence_type = 'submission_confirmation'
  );

-- A worker that dies between crossing the boundary and recording an outcome
-- leaves a row here forever, which is the intended trade: a stuck row that a
-- human resolves beats a silent second application.
create index application_attempts_submitting_idx
  on public.application_attempts (submission_started_at)
  where status = 'submitting';

-- ---------------------------------------------------------------------------
-- CANDIDATES CANNOT FORGE ACCEPTANCE. No grant or policy is added here.
-- 20260817090010 gave authenticated SELECT only on application_attempts
-- ("No mutation grant for authenticated"), and application_evidence grants
-- reads through the attempt's owner. Writes to both remain service_role-only,
-- which is the only path that can now satisfy the trigger.
--
-- VALIDATION QUERIES — run after applying, none executed here.
--
-- 1. The status CHECK accepts the new value and no old one was lost:
--      select pg_get_constraintdef(oid) from pg_constraint
--      where conname = 'application_attempts_status_check';
--      -- expect all 8 values including 'submitting'
--
-- 2. No 'succeeded' row lacks a confirmation:
--      select count(*) from public.application_attempts a
--      where a.status = 'succeeded'
--        and not exists (select 1 from public.application_evidence e
--                        where e.application_attempt_id = a.id
--                          and e.evidence_type = 'submission_confirmation');
--      -- expect 0
--
-- 3. The trigger refuses a forged acceptance (run as service_role, in a
--    transaction you roll back):
--      begin;
--      update public.application_attempts set status = 'succeeded'
--        where id = '<an attempt with no confirmation>';
--      -- expect 23514
--      rollback;
--
-- 4. A 'submitting' row is not reclaimable:
--      update public.application_attempts set status = 'submitting',
--        leased_until = now() - interval '1 day' where id = '<id>';
--      select * from public.claim_application_attempt();   -- must not return it
--
-- RECOVERY (never calls the adapter)
--   A 'submitting' row whose confirmation evidence exists is finished off:
--      update public.application_attempts a
--      set status = 'succeeded', succeeded_at = coalesce(a.succeeded_at, now()),
--          updated_at = now()
--      where a.status = 'submitting'
--        and exists (select 1 from public.application_evidence e
--                    where e.application_attempt_id = a.id
--                      and e.evidence_type = 'submission_confirmation');
--   A 'submitting' row with no confirmation has an UNKNOWN external outcome and
--   must be checked against the employer's portal by a human. There is no
--   automated path back to 'pending' by design.
-- ---------------------------------------------------------------------------
