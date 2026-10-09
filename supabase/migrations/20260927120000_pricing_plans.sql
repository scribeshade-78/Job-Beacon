-- JobBeacon pricing catalogue: four canonical plans, four billing regions
-- (IN / US / UK / EU), destination-split auto-apply quotas, monthly prices only.
--
-- MIRRORED BY shared/pricing.ts, WHICH IS THE SINGLE SOURCE OF TRUTH.
-- shared/pricing.parity.test.ts parses THIS FILE and fails if the two disagree,
-- so a price changed in one place and not the other is a test failure rather
-- than a silent divergence between what the pricing page shows and what the
-- checkout route would charge. That test depends on the two labelled value
-- lists below keeping their one-tuple-per-line shape; reformat them and the test
-- will say so.
--
-- WHY GBP IS NEW. PRD v3 §27.1 names INR, USD and EUR. The UK/GBP column is a
-- founder decision taken after that, so the two region/currency CHECK
-- constraints are widened here and the departure is recorded rather than
-- quietly absorbed. No other region/currency pair becomes legal.
--
-- RE-RUNNABLE. Every step tolerates being applied twice: the two CHECKs are
-- dropped and recreated, the new columns use IF NOT EXISTS, and every write is
-- an upsert on an existing unique key. The CHECKs are located BY DEFINITION
-- rather than by name because Postgres auto-generated their original names
-- (regional_prices_check, subscriptions_check, ...), and guessing those would
-- make this migration silently leave the old constraint in place — which would
-- then reject every UK row it is here to allow.

-- ---------------------------------------------------------------------------
-- 1. Allow (UK, GBP) on both tables that pair a region with a currency.
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
       and pg_get_constraintdef(oid) like '%region%'
       and pg_get_constraintdef(oid) like '%currency%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table public.regional_prices
  drop constraint if exists regional_prices_region_currency_check;
alter table public.regional_prices
  add constraint regional_prices_region_currency_check
  check ((region = 'IN' and currency = 'INR')
      or (region = 'US' and currency = 'USD')
      or (region = 'UK' and currency = 'GBP')
      or (region = 'EU' and currency = 'EUR'));

alter table public.subscriptions
  drop constraint if exists subscriptions_region_currency_check;
alter table public.subscriptions
  add constraint subscriptions_region_currency_check
  check ((region = 'IN' and currency = 'INR')
      or (region = 'US' and currency = 'USD')
      or (region = 'UK' and currency = 'GBP')
      or (region = 'EU' and currency = 'EUR'));

comment on constraint regional_prices_region_currency_check on public.regional_prices is
  'A region and a currency that do not belong together is a bug that would be quoted to a customer. GBP/UK was added after PRD v3 §27.1 named only INR, USD and EUR.';

-- ---------------------------------------------------------------------------
-- 2. The two destination auto-apply quotas.
--
-- DESTINATION IS WHERE THE JOB IS, NOT WHERE THE CANDIDATE IS. These are new
-- columns rather than a reuse of max_verified_applications_per_month because the
-- product states this allowance twice, once for India and once for the US, and a
-- single integer cannot express that. NULL still means "not configured" and is
-- still permissive, matching every other column in this table.
-- ---------------------------------------------------------------------------
alter table public.plan_limits
  add column if not exists max_auto_apply_india_per_month integer,
  add column if not exists max_auto_apply_us_per_month integer;

alter table public.plan_limits
  drop constraint if exists plan_limits_max_auto_apply_india_per_month_check;
alter table public.plan_limits
  add constraint plan_limits_max_auto_apply_india_per_month_check
  check (max_auto_apply_india_per_month is null or max_auto_apply_india_per_month >= 0);

alter table public.plan_limits
  drop constraint if exists plan_limits_max_auto_apply_us_per_month_check;
alter table public.plan_limits
  add constraint plan_limits_max_auto_apply_us_per_month_check
  check (max_auto_apply_us_per_month is null or max_auto_apply_us_per_month >= 0);

comment on column public.plan_limits.max_auto_apply_india_per_month is
  'Auto-apply allowance per month for jobs whose destination is India. Destination is a property of the job, not of the candidate.';
comment on column public.plan_limits.max_auto_apply_us_per_month is
  'Auto-apply allowance per month for jobs whose destination is the US. See max_auto_apply_india_per_month.';

-- ---------------------------------------------------------------------------
-- 3. The four canonical plans.
--
-- concierge is RENAMED, not deleted, so any subscription already pointing at it
-- keeps its foreign key and simply becomes Power. The rename is guarded so a
-- second run (or a database where power already exists) cannot violate the
-- unique constraint on code; in that case the UPDATE at the end deactivates the
-- leftover. tier_rank > 0 is a table CHECK and all four ranks are distinct.
-- ---------------------------------------------------------------------------
update public.subscription_plans
   set code = 'power', updated_at = now()
 where code = 'concierge'
   and not exists (select 1 from public.subscription_plans p where p.code = 'power');

insert into public.subscription_plans (code, display_name, description, tier_rank, is_active) values
  ('free',    'Free',    'Everything needed to search, tailor and track, with no automation.', 1, true),
  ('starter', 'Starter', 'Entry tier for a candidate running a focused search.',               2, true),
  ('pro',     'Premium International', 'Full autonomous discovery and application for an active search.', 3, true),
  ('power',   'Professional',          'Highest allowance, for a candidate applying at volume.',             4, true)
on conflict (code) do update
  set display_name = excluded.display_name,
      description = excluded.description,
      tier_rank = excluded.tier_rank,
      is_active = true,
      updated_at = now();

update public.subscription_plans
   set is_active = false, updated_at = now()
 where code not in ('free', 'starter', 'pro', 'power');

-- Every plan needs a limits row before the values below can be written to it.
-- The original migration seeded one per plan; 'free' is new here.
insert into public.plan_limits (plan_id)
select p.id from public.subscription_plans p
 where not exists (select 1 from public.plan_limits l where l.plan_id = p.id);

-- ---------------------------------------------------------------------------
-- 4. Quota values. (column order: code, india, us, verified, mailboxes)
-- ---------------------------------------------------------------------------
-- PARITY-BLOCK:QUOTAS-BEGIN
update public.plan_limits pl
   set max_auto_apply_india_per_month = v.india,
       max_auto_apply_us_per_month = v.us,
       max_verified_applications_per_month = v.verified,
       max_mailbox_connections = v.mailboxes,
       updated_at = now()
  from (values
    ('free',    0,    0,    15,   0),
    ('starter', 100,  100,  100,  1),
    ('pro',     500,  500,  500,  1),
    ('power',   1000, 1000, 1000, 1)
  ) as v(code, india, us, verified, mailboxes)
  join public.subscription_plans p on p.code = v.code
 where pl.plan_id = p.id;
-- PARITY-BLOCK:QUOTAS-END

-- ---------------------------------------------------------------------------
-- 5. Prices: the monthly matrix and the weekly matrix.
--
-- The annual rows were seeded unpriced and inactive and no figure was ever
-- given for them, so they are deleted rather than left to render as a permanent
-- "Not priced" in the admin console. billing_interval keeps 'year' in its CHECK
-- so annual pricing can return without another constraint change.
--
-- 'week' IS SPARED BY THIS DELETE, AND THAT IS LOAD-BEARING RATHER THAN TIDY.
-- This file declares itself re-runnable, so a version of this line that removed
-- weekly rows would silently delete the whole weekly catalogue on a re-run —
-- while the parity test, which reads the blocks below, went on passing.
-- ---------------------------------------------------------------------------
delete from public.regional_prices
 where billing_interval <> 'month'
   and billing_interval <> 'week';

delete from public.regional_prices rp
 using public.subscription_plans p
 where p.id = rp.plan_id
   and p.code not in ('free', 'starter', 'pro', 'power');

-- PARITY-BLOCK:PRICES-BEGIN
insert into public.regional_prices (plan_id, region, currency, billing_interval, amount_minor, is_active)
select p.id, v.region, v.currency, 'month', v.amount_minor, true
  from (values
    ('free',    'IN', 'INR', 0),
    ('free',    'US', 'USD', 0),
    ('free',    'UK', 'GBP', 0),
    ('free',    'EU', 'EUR', 0),
    ('starter', 'IN', 'INR', 19900),
    ('starter', 'US', 'USD', 599),
    ('starter', 'UK', 'GBP', 499),
    ('starter', 'EU', 'EUR', 599),
    ('pro',     'IN', 'INR', 99900),
    ('pro',     'US', 'USD', 2999),
    ('pro',     'UK', 'GBP', 2499),
    ('pro',     'EU', 'EUR', 2999),
    ('power',   'IN', 'INR', 199900),
    ('power',   'US', 'USD', 5999),
    ('power',   'UK', 'GBP', 4999),
    ('power',   'EU', 'EUR', 5999)
  ) as v(code, region, currency, amount_minor)
  join public.subscription_plans p on p.code = v.code
on conflict (plan_id, region, billing_interval) do update
  set currency = excluded.currency,
      amount_minor = excluded.amount_minor,
      is_active = excluded.is_active,
      updated_at = now();
-- PARITY-BLOCK:PRICES-END

-- PARITY-BLOCK:WEEKLY-PRICES-BEGIN
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
-- PARITY-BLOCK:WEEKLY-PRICES-END
