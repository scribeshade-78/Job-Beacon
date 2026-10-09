-- ---------------------------------------------------------------------------
-- Phase 2a - the monthly pricing matrix: names, prices and quotas.
--
-- WHY THIS EXISTS ALONGSIDE A CHANGE TO THE SEED. The catalogue is seeded by
-- 20260927120000_pricing_plans.sql, and shared/pricing.parity.test.ts reads that
-- file's two PARITY-BLOCK lists and fails when they disagree with PLAN_CATALOGUE.
-- So the seed had to be updated with the new numbers. But the seed's writes only
-- run when it is applied - on a fresh replay or a new database - so every
-- environment that already applied it, production included, would otherwise keep
-- the old prices forever while the code advertised the new ones. This is the
-- forward half: the same values, applied to a database that already saw the seed.
-- The two must agree, and the parity test is what enforces the seed's side.
--
-- NO PARITY BLOCKS HERE, deliberately. The test resolves one migration path, so
-- there is exactly one place the numbers are checked. Duplicating the lists in
-- this file would create a second source of truth that nothing verifies.
--
-- DERIVED FROM shared/pricing.ts, which is canonical for the catalogue.
--
-- INTERVALS: monthly only. 'year' remains legal in the CHECK but unpriced, and
-- 'week' is not legal yet - the weekly matrix is Phase 2b and needs its own
-- constraint changes on regional_prices and subscriptions first.
--
-- NOT HERE, DELIBERATELY: UK/GBP is kept as a first-class region rather than
-- folded into the rest-of-world fallback. Dropping it would have re-priced every
-- existing UK subscription in USD. Daily-discovery and AI-credit allowances have
-- no column and no meter, so they are Phase 2c; add-on credit packs are a new
-- purchase-and-ledger feature, Phase 2d.
-- ---------------------------------------------------------------------------

-- 1. Display names. NO CODE IS RENAMED. subscriptions reference plan_id, and
--    PLAN_CODES, the parity test, FEATURE_MATRIX and every stored row key on
--    `code`; renaming would ripple through all of them for a customer-visible
--    change that display_name already delivers.
update public.subscription_plans
   set display_name = 'Premium International', updated_at = now()
 where code = 'pro';

update public.subscription_plans
   set display_name = 'Professional', updated_at = now()
 where code = 'power';

-- 2. Quotas. (column order: code, india, us, verified, mailboxes)
--
-- FREE'S max_auto_apply_* STAYS 0, AND THAT IS A SAFETY BOUNDARY, NOT A NUMBER.
-- loadAutomationEntitlement reads those two columns as a boolean - "is either
-- destination above zero?" - and does not count usage, so a non-zero Free row
-- would grant unlimited automatic applications rather than a small allowance.
-- See its own "THE QUOTA IS NOT YET A COUNTER" note; this stays 0 until the
-- consumption counter exists in Phase 2c.
--
-- Free's max_verified_applications_per_month is 15. Nothing enforces it and
-- nothing gates on it: verified before setting it that the column is read only by
-- the billing display matrix (server/billing/entitlements.ts and
-- server/admin/billing.ts) and never by an eligibility or authorization path.
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

-- 3. Monthly prices, every region - including UK/GBP, which stays first-class.
--    Upsert on the same key as the seed, so this is safe to re-run and also
--    repairs a row a partial environment is missing.
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
