-- ---------------------------------------------------------------------------
-- Phase 2c M4 - the metered limits: weekly automation, weekly tracked
-- applications, AI credits and daily discovery.
--
-- WHY THESE COLUMNS ARRIVE NOW AND NOT IN PHASE 2A. We deliberately refused to
-- add unmetered quota columns then: loadAutomationEntitlement reads a non-zero
-- allowance as "entitled" and does not count usage, so a column nothing consumes
-- is a headline, not a limit. The counters landed in 20261011000000; these
-- columns are the limits those counters are measured against.
--
-- TWO DIFFERENT "APPLICATIONS", AND THE NAMES SAY WHICH:
--   * max_auto_apply_*_per_week  - the AUTOMATION allowance. This is what the
--     eligibility gate compares consumed attempts against.
--   * max_verified_applications_per_week - the candidate's TRACKED allowance, the
--     5/25/100/200 shown on the weekly plans. It gates nothing.
-- Conflating them would either let a paid plan automate nothing or let a tracked
-- allowance authorise submissions.
--
-- FREE'S AUTOMATION STAYS 0 AT BOTH CADENCES. That is the safety boundary: with
-- M5 now comparing consumption, a non-zero Free row would hand out unlimited
-- automated applications the moment a source became capable.
--
-- max_daily_discovery_jobs IS NOT PER-PERIOD. Discovery resets on the CALENDAR
-- DAY, not on the billing period, and its window is date_trunc('day', now()).
-- Reusing the billing period for it would silently turn "50 a day" into
-- "50 a month".
-- ---------------------------------------------------------------------------
alter table public.plan_limits
  add column if not exists max_auto_apply_india_per_week integer,
  add column if not exists max_auto_apply_us_per_week integer,
  add column if not exists max_verified_applications_per_week integer,
  add column if not exists max_ai_credits_per_month integer,
  add column if not exists max_ai_credits_per_week integer,
  add column if not exists max_daily_discovery_jobs integer;

alter table public.plan_limits
  drop constraint if exists plan_limits_max_auto_apply_india_per_week_check;
alter table public.plan_limits
  add constraint plan_limits_max_auto_apply_india_per_week_check
  check (max_auto_apply_india_per_week is null or max_auto_apply_india_per_week >= 0);
alter table public.plan_limits
  drop constraint if exists plan_limits_max_auto_apply_us_per_week_check;
alter table public.plan_limits
  add constraint plan_limits_max_auto_apply_us_per_week_check
  check (max_auto_apply_us_per_week is null or max_auto_apply_us_per_week >= 0);
alter table public.plan_limits
  drop constraint if exists plan_limits_max_verified_applications_per_week_check;
alter table public.plan_limits
  add constraint plan_limits_max_verified_applications_per_week_check
  check (max_verified_applications_per_week is null or max_verified_applications_per_week >= 0);
alter table public.plan_limits
  drop constraint if exists plan_limits_max_ai_credits_per_month_check;
alter table public.plan_limits
  add constraint plan_limits_max_ai_credits_per_month_check
  check (max_ai_credits_per_month is null or max_ai_credits_per_month >= 0);
alter table public.plan_limits
  drop constraint if exists plan_limits_max_ai_credits_per_week_check;
alter table public.plan_limits
  add constraint plan_limits_max_ai_credits_per_week_check
  check (max_ai_credits_per_week is null or max_ai_credits_per_week >= 0);
alter table public.plan_limits
  drop constraint if exists plan_limits_max_daily_discovery_jobs_check;
alter table public.plan_limits
  add constraint plan_limits_max_daily_discovery_jobs_check
  check (max_daily_discovery_jobs is null or max_daily_discovery_jobs >= 0);

comment on column public.plan_limits.max_auto_apply_india_per_week is
  'AUTOMATION allowance per week for jobs whose destination is India. Compared against consumed attempts by the plan_entitlement gate. Distinct from max_verified_applications_per_week, which is a display allowance.';
comment on column public.plan_limits.max_verified_applications_per_week is
  'TRACKED applications per week, shown on the pricing page. Gates nothing - see max_auto_apply_india_per_week for the one that does.';
comment on column public.plan_limits.max_ai_credits_per_month is
  'AI credits per billing period. One credit is one resume-tailoring or deep-cover-letter generation run, spent from candidate_usage_events.';
comment on column public.plan_limits.max_daily_discovery_jobs is
  'Distinct vacancies that may be first surfaced for this candidate per CALENDAR DAY - not per billing period. Counted from candidate_usage_events rows keyed (candidate, vacancy, day), so re-reads and re-sorts cost nothing.';

-- THE PARITY-TEST FIXTURE LIVES HERE, NOT IN THE SEED. 20260927120000 runs
-- before these columns exist, so it cannot write them; pricing.parity.test.ts
-- resolves a path per block and reads this one from this file.
-- (column order: code, auto_india_wk, auto_us_wk, verified_wk, credits_mo, credits_wk, discovery_day)
-- PARITY-BLOCK:USAGE-LIMITS-BEGIN
update public.plan_limits pl
   set max_auto_apply_india_per_week = v.auto_india_wk,
       max_auto_apply_us_per_week = v.auto_us_wk,
       max_verified_applications_per_week = v.verified_wk,
       max_ai_credits_per_month = v.credits_mo,
       max_ai_credits_per_week = v.credits_wk,
       max_daily_discovery_jobs = v.discovery_day,
       updated_at = now()
  from (values
    ('free',    0,    0,    5,    2,    2,    50),
    ('starter', 25,   25,   25,   100,  25,   150),
    ('pro',     100,  100,  100,  500,  125,  800),
    ('power',   200,  200,  200,  1000, 250,  1500)
  ) as v(code, auto_india_wk, auto_us_wk, verified_wk, credits_mo, credits_wk, discovery_day)
  join public.subscription_plans p on p.code = v.code
 where pl.plan_id = p.id;
-- PARITY-BLOCK:USAGE-LIMITS-END
