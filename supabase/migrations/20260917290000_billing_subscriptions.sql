-- Task H1: billing and subscriptions — the schema foundation.
--
-- PRD v3 §27 names the commercial model but supplies almost none of its
-- content, and that distinction governs every choice in this file:
--
--   SPECIFIED BY THE PRD. The eight plan-limit dimensions, quoted verbatim in
--   §27.2: active target roles; verified applications per month; premium source
--   access; ATS resume variants; mailbox connections; company intelligence
--   depth; priority action-required support; historical analytics and exports.
--   The three currencies INR, USD and EUR (§27.1). The existence of plans,
--   credits and entitlements (§28, the R7 row). And the §27.3 rule that a
--   commercial entitlement may NEVER override a source rate limit, a trust
--   block, candidate eligibility, a legal restriction or a safety control.
--
--   NOT SPECIFIED BY THE PRD, therefore NOT invented here. The PRD contains no
--   currency amount anywhere, no tier names, and no per-tier numeric limit. So
--   every limit column below is NULLABLE, and NULL means NOT CONFIGURED rather
--   than zero or unlimited — see server/billing/entitlements.ts, which treats an
--   unconfigured dimension as permissive. Storing a guessed number would put a
--   commercial promise in the database that no source document supports, and
--   the first person to trust it would be a paying candidate.
--
-- PRICES. The rows seeded at the bottom are an explicit founder decision, not a
-- PRD derivation: Starter 899, Pro 2499, Concierge 6999 in INR per month, reused
-- from the founder's earlier JobBeacon pricing. No other region and no annual
-- interval was ever given a figure, so those rows are created UNPRICED and
-- INACTIVE rather than left absent — an unpriced row is visible in the admin
-- console and says "not priced yet", whereas a missing row looks like an
-- oversight nobody can see.
--
-- DELIBERATELY NOT MODELLED. §28's R7 row also mentions "credits" and
-- "reconciliation". Neither is defined by any requirement: there is no statement
-- of what a credit buys or what is reconciled against what. This is the same
-- "no taxonomy until a requirement defines one" rule follow_up_drafts.status and
-- response_classifications.category already follow, so no credits ledger and no
-- reconciliation table is created. They arrive with their own requirement.

-- ---------------------------------------------------------------------------
-- 1. The plans.
--
-- A plan is a tier a candidate can be on. It carries no limits itself: limits
-- live in plan_limits, one row per plan, so that a plan without configured
-- limits is representable and is the honest starting state for all three.
-- ---------------------------------------------------------------------------
create table public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  display_name text not null,
  description text,
  /** Ordering for display only. Lower sorts first; nothing computes on it. */
  tier_rank integer not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (length(trim(code)) > 0),
  check (tier_rank > 0)
);

comment on table public.subscription_plans is
  'Tiers a candidate can subscribe to (PRD v3 §27.2, §28 R7). A plan with no configured limits is valid and is the state all seeded plans start in.';

-- ---------------------------------------------------------------------------
-- 2. The eight §27.2 dimensions.
--
-- One row per plan, typed columns rather than a key/value dimension table, so
-- that "this plan has no limit configured for dimension X" is a NULL in a known
-- column the compiler and the admin form can both see, instead of a missing row
-- that every reader has to remember to handle.
--
-- The eighth dimension is COMPOUND in the PRD — "Historical analytics and
-- exports" names two capabilities joined by "and" — so it is modelled as two
-- columns. That is a deliberate deviation from a strict one-column-per-bullet
-- reading, and it is the only one: a single boolean could not let a plan enable
-- analytics history without also enabling exports.
--
-- Types follow the dimension's own wording. "Access", "support" and "exports"
-- are capabilities, so they are booleans. "Depth" is ordinal, so it is a
-- small closed set. The rest are counts.
-- ---------------------------------------------------------------------------
create table public.plan_limits (
  plan_id uuid primary key references public.subscription_plans (id) on delete cascade,

  /** §27.2 "Active target roles" — rows in candidate_selected_roles. */
  max_active_target_roles integer,
  /** §27.2 "Verified applications per month" — succeeded application_attempts in the current calendar month. */
  max_verified_applications_per_month integer,
  /** §27.2 "Premium source access". No source_policies row is flagged premium yet, so this is configurable but currently has no effect — recorded rather than hidden. */
  premium_source_access boolean,
  /** §27.2 "ATS resume variants" — resume_documents rows with kind = tailored. */
  max_ats_resume_variants integer,
  /** §27.2 "Mailbox connections" — mailbox_connections rows with status = connected. */
  max_mailbox_connections integer,
  /** §27.2 "Company intelligence depth". Ordinal because the dimension is a depth, not a count. */
  company_intelligence_depth text,
  /** §27.2 "Priority action-required support". */
  priority_action_required_support boolean,
  /** §27.2 "Historical analytics and exports" — first of the two columns that dimension needs. */
  analytics_history_days integer,
  /** §27.2 "Historical analytics and exports" — second of the two. */
  data_exports_enabled boolean,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (company_intelligence_depth is null or company_intelligence_depth in ('none', 'basic', 'full')),
  -- NULL is "not configured"; a negative limit is not a limit, it is a typo.
  check (max_active_target_roles is null or max_active_target_roles >= 0),
  check (max_verified_applications_per_month is null or max_verified_applications_per_month >= 0),
  check (max_ats_resume_variants is null or max_ats_resume_variants >= 0),
  check (max_mailbox_connections is null or max_mailbox_connections >= 0),
  check (analytics_history_days is null or analytics_history_days >= 0)
);

comment on table public.plan_limits is
  'One row per plan, carrying PRD v3 §27.2 eight plan-limit dimensions. NULL means NOT CONFIGURED — never zero, and never "unlimited". §27.3 forbids describing a plan-constrained application allowance as unlimited, so the admin UI renders NULL as "Not configured" and never as "Unlimited".';

comment on column public.plan_limits.premium_source_access is
  'PRD v3 §27.2 "Premium source access". No row in source_policies is currently flagged premium, so enabling this changes nothing yet. Recorded as a known inert dimension rather than silently omitted.';

comment on column public.plan_limits.analytics_history_days is
  'PRD v3 §27.2 "Historical analytics and exports", first half. The PRD names a compound capability; it is split into two columns so a plan can grant one without the other.';

-- ---------------------------------------------------------------------------
-- 3. Regional pricing.
--
-- One row per plan x region x billing interval. region and currency are held
-- together by a CHECK rather than by convention: PRD §27.1 names INR, USD and
-- EUR as the supported trio, and a row pairing region IN with currency USD is
-- not a regional price, it is a bug that would be quoted to a customer.
--
-- amount_minor is in MINOR UNITS (paise, cents) so no price ever touches a
-- floating-point type. 899 INR is 89900.
--
-- The is_active/amount_minor CHECK is the one that earns its keep: an unpriced
-- row cannot be activated. Without it, a plan could go live at a NULL price and
-- a checkout session would be created for zero.
-- ---------------------------------------------------------------------------
create table public.regional_prices (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.subscription_plans (id) on delete cascade,

  region text not null,
  currency text not null,
  billing_interval text not null,
  /** Minor units (paise / cents). NULL = not priced yet. */
  amount_minor bigint,
  /** False until a founder sets amount_minor. An unpriced row is intentionally visible in the admin console. */
  is_active boolean not null default false,
  effective_from timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (plan_id, region, billing_interval),

  check ((region = 'IN' and currency = 'INR') or (region = 'US' and currency = 'USD') or (region = 'EU' and currency = 'EUR')),
  check (billing_interval in ('month', 'year')),
  check (amount_minor is null or amount_minor >= 0),
  check (is_active = false or amount_minor is not null)
);

comment on table public.regional_prices is
  'PRD v3 §27.1 regional pricing across INR, USD and EUR. amount_minor is minor units. A row with amount_minor NULL is a region/interval that has not been priced yet; it is deliberately present so the gap is visible in the admin console.';

comment on column public.regional_prices.is_active is
  'Only an activated row may be quoted. The table CHECK forbids activating a row with no amount_minor, so a zero or absent price cannot reach a checkout session.';

-- ---------------------------------------------------------------------------
-- 4. Subscriptions.
--
-- One candidate may accumulate history, so this is not one row per candidate.
-- What IS one row per candidate is the SET of non-terminal subscriptions, which
-- the partial unique index below enforces: two simultaneously-live subscriptions
-- for one candidate would mean two answers to "which limits apply", and nothing
-- in the system could pick between them.
--
-- plan_id is NOT NULL. A subscription without a plan is not a subscription.
--
-- provider is a closed set that includes stripe (the one this phase is
-- structured for) and razorpay (PRD §27.1 launches on INR first, and the
-- founder's earlier product used Razorpay) and manual (an operator granting a
-- plan without a payment provider, which is how the first real subscription will
-- almost certainly be created). The provider-specific columns are nullable
-- because a manual grant has no provider ids.
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,
  plan_id uuid not null references public.subscription_plans (id),

  provider text not null,
  provider_customer_id text,
  provider_subscription_id text,

  status text not null,
  region text not null,
  currency text not null,
  billing_interval text not null,

  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (provider in ('stripe', 'razorpay', 'manual')),
  check (status in ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'canceled')),
  check ((region = 'IN' and currency = 'INR') or (region = 'US' and currency = 'USD') or (region = 'EU' and currency = 'EUR')),
  check (billing_interval in ('month', 'year')),
  check (current_period_end is null or current_period_start is null or current_period_end > current_period_start)
);

create unique index subscriptions_provider_subscription_idx
  on public.subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;

-- At most one live subscription per candidate. 'canceled' is terminal; the
-- others are all live states, so a past_due subscription still blocks a second
-- one from being created alongside it.
create unique index subscriptions_one_live_per_candidate_idx
  on public.subscriptions (candidate_id)
  where status in ('incomplete', 'trialing', 'active', 'past_due', 'unpaid');

create index subscriptions_candidate_idx on public.subscriptions (candidate_id, created_at desc);

comment on table public.subscriptions is
  'Per-candidate subscription state. At most one non-terminal row per candidate, enforced by a partial unique index. No billing/entitlement logic lives here — see server/billing/.';

-- ---------------------------------------------------------------------------
-- 5. Seed: the three tiers and their India monthly prices.
-- ---------------------------------------------------------------------------
insert into public.subscription_plans (code, display_name, description, tier_rank) values
  ('starter', 'Starter', 'Entry tier for a candidate running a focused search.', 1),
  ('pro', 'Pro', 'Full autonomous discovery and application for an active search.', 2),
  ('concierge', 'Concierge', 'Hands-on tier with a human in the loop.', 3);

-- One all-NULL limits row per plan. This is the honest starting state: the eight
-- §27.2 dimensions are configured structures with no agreed values, not missing
-- features. Inserting them now means a founder fills in numbers later rather
-- than a developer inventing an endpoint shape later.
insert into public.plan_limits (plan_id)
select id from public.subscription_plans;

-- Every plan x region x interval combination, unpriced and inactive.
insert into public.regional_prices (plan_id, region, currency, billing_interval)
select p.id, r.region, r.currency, iv.interval_code
from public.subscription_plans p
cross join (values ('IN', 'INR'), ('US', 'USD'), ('EU', 'EUR')) as r (region, currency)
cross join (values ('month'), ('year')) as iv (interval_code);

-- The one combination with a founder-decided figure.
update public.regional_prices rp
set amount_minor = case p.code
      when 'starter' then 89900
      when 'pro' then 249900
      when 'concierge' then 699900
    end,
    is_active = true
from public.subscription_plans p
where p.id = rp.plan_id
  and rp.region = 'IN'
  and rp.billing_interval = 'month';

-- ---------------------------------------------------------------------------
-- 6. Access control.
--
-- Plans, limits and prices are global reference data with no per-user rows, so
-- they follow the _select_all precedent company_profiles and salary_benchmarks
-- already set: RLS enabled, select granted to authenticated, everything else
-- revoked, writes only through service_role.
--
-- subscriptions are per-candidate and follow the select-own shape. There is no
-- INSERT/UPDATE grant to authenticated at all: a candidate must not be able to
-- write their own subscription row, which is the single most valuable row in the
-- product to forge. Every write path goes through service_role.
-- ---------------------------------------------------------------------------
alter table public.subscription_plans enable row level security;
alter table public.plan_limits enable row level security;
alter table public.regional_prices enable row level security;
alter table public.subscriptions enable row level security;

revoke all on public.subscription_plans from public, anon, authenticated;
revoke all on public.plan_limits from public, anon, authenticated;
revoke all on public.regional_prices from public, anon, authenticated;
revoke all on public.subscriptions from public, anon, authenticated;

grant select on public.subscription_plans to authenticated;
grant select on public.plan_limits to authenticated;
grant select on public.regional_prices to authenticated;
grant select on public.subscriptions to authenticated;

grant select, insert, update, delete on public.subscription_plans to service_role;
grant select, insert, update, delete on public.plan_limits to service_role;
grant select, insert, update, delete on public.regional_prices to service_role;
grant select, insert, update, delete on public.subscriptions to service_role;

create policy "subscription_plans_select_all"
  on public.subscription_plans for select to authenticated using (true);

create policy "plan_limits_select_all"
  on public.plan_limits for select to authenticated using (true);

create policy "regional_prices_select_all"
  on public.regional_prices for select to authenticated using (true);

create policy "subscriptions_select_own"
  on public.subscriptions for select to authenticated
  using (candidate_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 7. Usage, for the countable dimensions.
--
-- Only four of the eight §27.2 dimensions are counts. The other four (premium
-- source access, company intelligence depth, priority action-required support,
-- analytics history and exports) are capabilities read straight off plan_limits,
-- so they need no query and are deliberately absent from this function's shape.
--
-- A function rather than four PostgREST counts because "verified applications
-- this month" is a join across application_attempts -> application_plans behind
-- a candidate filter, and because the calendar-month boundary must be defined
-- once. date_trunc on now() in the database's timezone: the month is the
-- deployment's month, not the browser's.
--
-- security invoker (the default, stated here so it is not mistaken for an
-- oversight) and execute is granted to service_role only: this reads across
-- tables, and it is called by the API, never by a candidate's own session.
-- ---------------------------------------------------------------------------
create function public.candidate_entitlement_usage(p_candidate_id uuid)
returns table (
  active_target_roles integer,
  verified_applications_this_month integer,
  ats_resume_variants integer,
  connected_mailboxes integer
)
language sql
security invoker
stable
as $$
  select
    (select count(*)::integer
       from public.candidate_selected_roles r
      where r.candidate_id = p_candidate_id),
    (select count(*)::integer
       from public.application_attempts a
       join public.application_plans pl on pl.id = a.application_plan_id
      where pl.candidate_id = p_candidate_id
        and a.status = 'succeeded'
        and a.succeeded_at >= date_trunc('month', now())),
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
  'Current usage for the four countable PRD v3 §27.2 dimensions. "Verified applications" counts succeeded attempts in the current calendar month; "ATS resume variants" counts resume_documents rows with kind = tailored.';

revoke all on function public.candidate_entitlement_usage(uuid) from public, anon, authenticated;
grant execute on function public.candidate_entitlement_usage(uuid) to service_role;
