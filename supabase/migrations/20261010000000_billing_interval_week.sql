-- ---------------------------------------------------------------------------
-- Phase 2b (part 1) - allow a WEEKLY billing interval.
--
-- WHY THE CHECK IS LOCATED BY DEFINITION AND NOT BY NAME. Both constraints were
-- declared inline on the column, so Postgres generated their names. 20260927120000
-- set this precedent for the region/currency constraints and said why: guessing a
-- generated name leaves the OLD constraint in place, and it then rejects every row
-- the migration exists to allow. Matching on "the CHECK on one of these two tables
-- whose definition mentions billing_interval" cannot miss. The region/currency
-- CHECKs are not matched because they never mention billing_interval.
--
-- ADDITIVE AND DATA-FREE. 'month' and 'year' stay legal, no weekly price row is
-- inserted, and no subscription is touched, so a database that never sells a
-- weekly plan behaves exactly as it did. What makes a weekly plan PURCHASABLE is
-- part 2 (the PlanDefinition refactor plus the weekly prices), which is blocked on
-- the two answers recorded at the bottom of this file.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname, conrelid::regclass::text as tbl
      from pg_constraint
     where conrelid in ('public.regional_prices'::regclass, 'public.subscriptions'::regclass)
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%billing_interval%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

-- Named explicitly from here on, so the next widening does not have to guess a
-- generated name again.
alter table public.regional_prices
  add constraint regional_prices_billing_interval_check
  check (billing_interval in ('week', 'month', 'year'));

alter table public.subscriptions
  add constraint subscriptions_billing_interval_check
  check (billing_interval in ('week', 'month', 'year'));

comment on constraint regional_prices_billing_interval_check on public.regional_prices is
  'A price row carries the interval it is priced for. week was added for the weekly plans; year remains legal but unpriced.';

comment on constraint subscriptions_billing_interval_check on public.subscriptions is
  'Mirrors regional_prices_billing_interval_check. A subscription records the interval it was BOUGHT at, and a later catalogue change never rewrites it.';

-- ---------------------------------------------------------------------------
-- The weekly prices, for every plan and region.
--
-- NO PARITY-BLOCK MARKERS HERE, deliberately: shared/pricing.parity.test.ts
-- resolves exactly one migration path (20260927120000) for the block it parses, so
-- duplicating the markers in this file would create a second copy of the numbers
-- that nothing checks. This statement is the forward half — see that file's
-- WEEKLY-PRICES block, which is the copy the test verifies.
-- ---------------------------------------------------------------------------
insert into public.regional_prices (plan_id, region, currency, billing_interval, amount_minor, is_active)
select p.id, v.region, v.currency, 'week', v.amount_minor, true
  from (values
    ('free',    'IN', 'INR', 0),
    ('free',    'US', 'USD', 0),
    ('free',    'UK', 'GBP', 0),
    ('free',    'EU', 'EUR', 0),
    ('starter', 'IN', 'INR', 5900),
    ('starter', 'US', 'USD', 199),
    ('starter', 'UK', 'GBP', 149),
    ('starter', 'EU', 'EUR', 199),
    ('pro',     'IN', 'INR', 29900),
    ('pro',     'US', 'USD', 899),
    ('pro',     'UK', 'GBP', 749),
    ('pro',     'EU', 'EUR', 899),
    ('power',   'IN', 'INR', 59900),
    ('power',   'US', 'USD', 1799),
    ('power',   'UK', 'GBP', 1499),
    ('power',   'EU', 'EUR', 1799)
  ) as v(code, region, currency, amount_minor)
  join public.subscription_plans p on p.code = v.code
on conflict (plan_id, region, billing_interval) do update
  set currency = excluded.currency,
      amount_minor = excluded.amount_minor,
      is_active = excluded.is_active,
      updated_at = now();

-- ---------------------------------------------------------------------------
-- STILL REQUIRED BEFORE A WEEKLY PLAN CAN ACTUALLY BE SOLD (phase 2b part 2):
--
--  1. WEEKLY GBP PRICES ARE MISSING. The monthly matrix carries GBP (Starter
--     GBP4.99, Premium International GBP24.99, Professional GBP49.99), and the
--     weekly figures were given only for INR, USD and EUR. shared/pricing.parity
--     .test.ts asserts every plan has a price for EVERY region and PLAN_CATALOGUE
--     types them as numbers, so a gap cannot be represented as null without
--     changing that assertion - which is a decision, not a transcription.
--
--  2. WEEKLY QUOTAS HAVE NO COLUMN. plan_limits stores per-MONTH figures
--     (max_verified_applications_per_month, max_ai_credits_*, ...), and the weekly
--     plans state per-WEEK allowances (5/25/100/200 applications). Two shapes are
--     possible - per-week columns, or an interval factor applied at consumption
--     time - and the counters that would read either do not exist until phase 2c.
--     Choosing now would lock in a model for a number nothing enforces yet.
-- ---------------------------------------------------------------------------
