-- Task C1: the anti-ghosting substrate.
--
-- Three things, and the first is a prerequisite the feature cannot be built
-- correctly without.

-- ---------------------------------------------------------------------------
-- 1. A trustworthy submission timestamp.
--
-- "Ghosted" means "submitted more than N days ago with no reply", so the
-- feature needs to know when the submission happened. application_attempts has
-- no such column, and the obvious substitute is wrong: updated_at means "last
-- modified", and it demonstrably moves for reasons unrelated to submission.
-- The live database proves it — an attempt created at 21:46 has updated_at
-- 21:52, because writing its cover letter touched the row while it sat in
-- pending_review. Keying a seven-day clock on that column means any future
-- write to an attempt (a metadata backfill, an admin correction, a new
-- generated artifact) silently resets the clock and the application is never
-- flagged. A silent, permanent, per-row failure is the worst shape a bug can
-- take here.
--
-- Backfilled from application_evidence.captured_at, which IS written at the
-- moment of submission by the worker's success path and is therefore real
-- evidence rather than an inference. MIN over an attempt's evidence rows: the
-- first thing captured is when the submission happened.
--
-- Attempts with no evidence stay NULL. They are excluded by the detection
-- query rather than guessed at, because a succeeded attempt with no evidence
-- row is an anomaly worth looking at, not a follow-up candidate.
alter table public.application_attempts
  add column succeeded_at timestamptz;

update public.application_attempts a
  set succeeded_at = e.first_captured_at
  from (
    select application_attempt_id, min(captured_at) as first_captured_at
    from public.application_evidence
    group by application_attempt_id
  ) e
  where e.application_attempt_id = a.id
    and a.status = 'succeeded';

comment on column public.application_attempts.succeeded_at is
  'When the submission actually succeeded, written by the worker on the transition into status=succeeded. NOT updated_at, which is last-modified and moves for unrelated writes. NULL for attempts that never succeeded and for succeeded attempts that predate this column and have no evidence row to backfill from.';

-- ---------------------------------------------------------------------------
-- 2. The drafts.
--
-- ONE DRAFT PER ATTEMPT, enforced by a unique constraint rather than by worker
-- discipline. A follow-up is a property of one application, and two live drafts
-- for one attempt would need a "which one wins" rule that nothing can answer.
--
-- status is pending_review | approved | dismissed, and NO 'sent'. Sending is
-- explicitly out of scope for this phase and there is no email adapter, so a
-- 'sent' value would be a state nothing in the codebase could ever reach — the
-- same "no taxonomy until a requirement defines one" rule
-- response_classifications.category follows. The sending phase adds it.
--
-- model_version and prompt_version are NOT NULL, unlike the cover letter's
-- provenance columns which the generator supplies. Here the table itself
-- refuses a draft that cannot be audited: a follow-up is sent to an employer,
-- and "which prompt wrote this" must not be answerable only by hoping the
-- writer filled it in.
create table public.follow_up_drafts (
  id uuid primary key default gen_random_uuid(),
  application_attempt_id uuid not null references public.application_attempts (id) on delete cascade,

  draft_text text not null,
  status text not null default 'pending_review'
    check (status in ('pending_review', 'approved', 'dismissed')),

  model_version text not null,
  prompt_version text not null,
  generated_at timestamptz not null default now(),
  /** The per-paragraph fact citations the honesty gate approved, plus the application facts supplied. */
  metadata jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (application_attempt_id)
);

create index follow_up_drafts_status_idx on public.follow_up_drafts (status, generated_at desc);

alter table public.follow_up_drafts enable row level security;

revoke all on public.follow_up_drafts from public;
revoke all on public.follow_up_drafts from anon;
revoke all on public.follow_up_drafts from authenticated;

grant select on public.follow_up_drafts to authenticated;
grant select, insert, update, delete on public.follow_up_drafts to service_role;

-- Ownership is transitive, the same two-hop shape as application_attempts
-- itself: this table has no candidate_id, and adding one would be a second
-- place for ownership to be wrong.
create policy "follow_up_drafts_select_own"
  on public.follow_up_drafts
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.application_attempts a
      join public.application_plans p on p.id = a.application_plan_id
      where a.id = follow_up_drafts.application_attempt_id
        and p.candidate_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Detection, as one query.
--
-- A function rather than a PostgREST query because the "no replies" condition
-- is a NOT EXISTS over messages joined to their classification, and expressing
-- that through PostgREST's embedded-resource filters produces something nobody
-- can read or test.
--
-- WHAT COUNTS AS A REPLY, and this is a judgement the brief invited: any
-- message linked to the attempt, EXCEPT one classified application_received.
--
-- The exception is deliberate and it is the difference between this feature
-- working and being dead on arrival. "application_received" is an automatic
-- acknowledgement that the application arrived; it says nothing about progress
-- and it is the single most common email an ATS sends. Treating it as a reply
-- would mean almost every application is "not ghosted" within seconds of
-- submitting, and the feature would never fire in exactly the case it exists
-- for. A message that is linked but NOT yet classified counts as a reply:
-- unclassified mail is unproven, and the safe direction is to not send a
-- follow-up the employer has already answered.
create function public.find_ghosted_attempts(
  p_min_age_days integer default 7,
  p_limit integer default 50
)
returns table (
  application_attempt_id uuid,
  candidate_id uuid,
  vacancy_id uuid,
  submitted_at timestamptz,
  days_since_submission integer
)
language sql
stable
as $$
  select
    a.id,
    p.candidate_id,
    p.vacancy_id,
    a.succeeded_at,
    floor(extract(epoch from (now() - a.succeeded_at)) / 86400)::integer
  from public.application_attempts a
  join public.application_plans p on p.id = a.application_plan_id
  where a.status = 'succeeded'
    and a.succeeded_at is not null
    and a.succeeded_at < now() - make_interval(days => p_min_age_days)
    and not exists (
      select 1
      from public.messages m
      left join public.response_classifications rc on rc.message_id = m.id
      where m.application_attempt_id = a.id
        and coalesce(rc.category, '') <> 'application_received'
    )
    -- Already drafted. Includes dismissed: a candidate who dismissed a draft
    -- said no, and re-drafting behind their back would overrule that.
    and not exists (
      select 1 from public.follow_up_drafts d where d.application_attempt_id = a.id
    )
  order by a.succeeded_at
  limit p_limit;
$$;

revoke all on function public.find_ghosted_attempts(integer, integer) from public;
revoke all on function public.find_ghosted_attempts(integer, integer) from anon;
revoke all on function public.find_ghosted_attempts(integer, integer) from authenticated;
grant execute on function public.find_ghosted_attempts(integer, integer) to service_role;
