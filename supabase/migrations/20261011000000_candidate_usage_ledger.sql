-- ---------------------------------------------------------------------------
-- Phase 2c, part 1 (M1-M3) - the usage ledger and the billing period.
--
-- WHY A LEDGER AND NOT MORE COUNTERS. Everything here is append-only and the
-- numbers are read as sums over a WINDOW. Nothing is ever reset, because a
-- destructive reset job is where quota systems break: double-fired on retry,
-- skipped by a deploy, or wrong across a timezone boundary. A window that moves
-- cannot fail any of those ways.
--
-- APPLICATIONS ARE STILL NOT STORED HERE. application_attempts already carries a
-- timestamp for every attempt, so a second counter for it could only drift from
-- the events it claims to summarise. The ledger holds only what cannot be
-- derived: AI credit grants and spends (a balance is state, not an event stream)
-- and discovery runs (nothing attributes a run to a candidate today -
-- ingestion_jobs has no candidate_id and the intake fan-out writes to the global
-- vacancies table).
--
-- M4 (the new plan_limits columns) IS DELIBERATELY NOT HERE - see the note at the
-- end of this file.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- M1. The ledger.
-- ---------------------------------------------------------------------------
create table public.candidate_usage_events (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,
  kind text not null check (kind in ('ai_credit_grant', 'ai_credit_spend', 'discovery_run')),
  -- SIGNED ON PURPOSE: spends are negative, grants positive, so a balance is one
  -- SUM over this column rather than a second running-total column that can
  -- disagree with the rows it was computed from.
  quantity integer not null check (quantity <> 0),
  occurred_at timestamptz not null default now(),
  -- IDEMPOTENCY. The same discovery run or the same payment must never be
  -- counted twice, and the caller supplies the key: a run id, a provider payment
  -- id, or '<candidate>:<period-iso>:grant' for a rollover.
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (candidate_id, kind, idempotency_key)
);

-- The read is always "this candidate, this kind, since <window start>".
create index candidate_usage_events_window_idx
  on public.candidate_usage_events (candidate_id, kind, occurred_at desc);

alter table public.candidate_usage_events enable row level security;

-- NO POLICY, and no grant to authenticated: this is a service-role-only ledger,
-- the same shape as candidate_entitlement_usage. A candidate who could read it
-- could infer other tables' contents, and one who could write it could mint
-- themselves credits.
revoke all on public.candidate_usage_events from public, anon, authenticated;
grant select, insert on public.candidate_usage_events to service_role;

comment on table public.candidate_usage_events is
  'Append-only usage ledger for the dimensions that cannot be derived from existing tables: AI credit grants/spends and discovery runs. Applications are deliberately absent - application_attempts is their source of truth. Never updated, never deleted; windows move instead.';

-- ---------------------------------------------------------------------------
-- M2. One definition of "which period are we in".
--
-- THE CALENDAR MONTH WAS THE WRONG WINDOW. candidate_entitlement_usage used
-- date_trunc('month', now()), which is not the billing period: a subscription
-- started on the 20th got a fresh allowance on the 1st, so a candidate could
-- consume two allowances in twelve days by timing a purchase. It is also
-- meaningless for the weekly plans.
--
-- Subscription period first, calendar period second. A live subscription carries
-- current_period_start/end; a manual grant has neither (it has NO paid remainder
-- to honour) and Free has no row at all, so both fall back to the calendar period
-- matching the plan's own cadence.
-- ---------------------------------------------------------------------------
create function public.candidate_period_floor(p_interval text, p_at timestamptz default now())
returns timestamptz
language sql
immutable
as $$
  select case p_interval
    when 'week' then date_trunc('week', p_at)
    when 'year' then date_trunc('year', p_at)
    else date_trunc('month', p_at)
  end;
$$;

create function public.candidate_period_length(p_interval text)
returns interval
language sql
immutable
as $$
  select case p_interval
    when 'week' then interval '1 week'
    when 'year' then interval '1 year'
    else interval '1 month'
  end;
$$;

create function public.candidate_billing_period(p_candidate_id uuid, p_at timestamptz default now())
returns table (starts_at timestamptz, ends_at timestamptz, billing_interval text)
language sql
security invoker
stable
as $$
  with live as (
    select s.billing_interval, s.current_period_start, s.current_period_end
      from public.subscriptions s
     where s.candidate_id = p_candidate_id
       and s.status in ('incomplete', 'trialing', 'active', 'past_due', 'unpaid')
     order by s.created_at desc
     limit 1
  ),
  chosen as (
    select
      coalesce((select l.billing_interval from live l), 'month') as interval,
      (select l.current_period_start from live l) as paid_start,
      (select l.current_period_end from live l) as paid_end
  )
  select
    coalesce(c.paid_start, public.candidate_period_floor(c.interval, p_at)),
    coalesce(
      c.paid_end,
      public.candidate_period_floor(c.interval, p_at) + public.candidate_period_length(c.interval)
    ),
    c.interval
  from chosen c;
$$;

comment on function public.candidate_billing_period(uuid, timestamptz) is
  'The single definition of the current billing period: the live subscription''s own period when it has one, otherwise the calendar period matching the plan''s cadence (month for Free). Everything that answers "what is left this period" must call this rather than re-deriving a boundary.';

-- THE HELPERS NEED THE GRANT TOO, AND THAT IS NOT OBVIOUS. Revoking from PUBLIC
-- removes the implicit EXECUTE that every role inherits, and these three functions
-- are SECURITY INVOKER, so the calls INSIDE candidate_billing_period are checked
-- against the caller's own privileges. Granting only the outer function would have
-- produced "permission denied for function candidate_period_floor" from a
-- service-role call, i.e. every usage read would have failed at runtime — with no
-- error anywhere near the code that looked wrong.
revoke all on function public.candidate_period_floor(text, timestamptz) from public, anon, authenticated;
revoke all on function public.candidate_period_length(text) from public, anon, authenticated;
revoke all on function public.candidate_billing_period(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.candidate_period_floor(text, timestamptz) to service_role;
grant execute on function public.candidate_period_length(text) to service_role;
grant execute on function public.candidate_billing_period(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- M3. The usage read model: period-aware, and two different application counts.
--
-- WHY DROP RATHER THAN create or replace: Postgres refuses to change a function's
-- return type, and this one gains a column and renames another. Dropping also
-- drops the grants, so they are re-issued below - the easy thing to forget.
--
-- TWO APPLICATION NUMBERS, AND THEY ARE NOT INTERCHANGEABLE:
--   * verified_applications_this_period - status = 'succeeded'. This is what the
--     candidate actually got, and what the billing matrix shows.
--   * consumed_applications_this_period - EVERY status except 'cancelled'. This is
--     what a QUOTA must count. Counting only succeeded attempts would let a
--     candidate pass a 5-application allowance a hundred times from one bulk
--     request before a single attempt succeeded; MAX_BULK_APPLY_VACANCIES is 100.
--     The status domain matches rate_and_abuse_controls for the same reason.
-- ---------------------------------------------------------------------------
drop function public.candidate_entitlement_usage(uuid);

create function public.candidate_entitlement_usage(p_candidate_id uuid)
returns table (
  active_target_roles integer,
  verified_applications_this_period integer,
  consumed_applications_this_period integer,
  ats_resume_variants integer,
  connected_mailboxes integer
)
language sql
security invoker
stable
as $$
  with period as (select * from public.candidate_billing_period(p_candidate_id))
  select
    (select count(*)::integer
       from public.candidate_selected_roles r
      where r.candidate_id = p_candidate_id),
    (select count(*)::integer
       from public.application_attempts a
       join public.application_plans pl on pl.id = a.application_plan_id
      where pl.candidate_id = p_candidate_id
        and a.status = 'succeeded'
        and a.succeeded_at >= (select p.starts_at from period p)),
    (select count(*)::integer
       from public.application_attempts a
       join public.application_plans pl on pl.id = a.application_plan_id
      where pl.candidate_id = p_candidate_id
        and a.status <> 'cancelled'
        and a.created_at >= (select p.starts_at from period p)),
    (select count(*)::integer
       from public.resume_documents d
      where d.candidate_id = p_candidate_id
        and d.kind = 'tailored'),
    (select count(*)::integer
       from public.mailbox_connections m
      where m.candidate_id = p_candidate_id
        and m.status = 'connected');
$$;

comment on function public.candidate_entitlement_usage(uuid) is
  'Usage for the countable PRD v3 27.2 dimensions, over the CANDIDATE''S BILLING PERIOD rather than a calendar month. verified_* counts succeeded attempts; consumed_* counts every attempt except cancelled and is the one a quota must compare against.';

revoke all on function public.candidate_entitlement_usage(uuid) from public, anon, authenticated;
grant execute on function public.candidate_entitlement_usage(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- NOT IN THIS MIGRATION - M4, blocked on one decision.
--
-- "Weekly application limit" is ambiguous, and the two readings differ:
--   * max_verified_applications_per_week - the TRACKED allowance (the 5/25/100/200
--     figures shown on the weekly plans), and
--   * max_auto_apply_*_per_week - the AUTOMATION allowance the eligibility gate
--     actually compares against.
-- Applications already means two different things in this schema (see M3 above).
-- Adding a third ambiguous column would freeze the wrong reading into the table.
-- ---------------------------------------------------------------------------
