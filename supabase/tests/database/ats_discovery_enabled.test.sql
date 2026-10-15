begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- ===========================================================================
-- Enabling Greenhouse and Lever for DISCOVERY.
--
-- WHY THIS FILE EXISTS. Both adapters (server/ingestion/adapters/greenhouse.ts,
-- lever.ts) and their registry entries have existed for a while, and neither
-- runs, because server/ingestion/worker.ts refuses to start a discovery job
-- without a matching source_policies row:
--
--   throw policyError ?? new Error(`source_policies row for "${...}" not found.`);
--
-- So "the adapter is registered" and "the source is enabled" are different
-- facts, and only the first was true. This asserts the second.
--
-- THE GOVERNANCE LINE THESE ASSERTIONS DRAW. A Greenhouse/Lever board API is a
-- PUBLIC, UNAUTHENTICATED GET — Board API data is publicly available, so reading
-- it needs no employer permission. SUBMITTING an application is a different act
-- that does require an employer-issued credential, and it is deliberately NOT
-- authorized here. discovery/storage/display true with automated_application
-- false is that distinction expressed as data.
-- ===========================================================================

-- --- greenhouse -------------------------------------------------------------
select ok(
  exists(select 1 from public.source_policies where source_code = 'greenhouse'),
  'greenhouse: a source_policies row exists (worker.ts throws without one)'
);
select is(
  (select discovery_allowed from public.source_policies where source_code = 'greenhouse'),
  true,
  'greenhouse: discovery_allowed — the board API is public and unauthenticated'
);
select is(
  (select storage_allowed from public.source_policies where source_code = 'greenhouse'),
  true,
  'greenhouse: storage_allowed — listings are persisted as vacancies'
);
select is(
  (select display_allowed from public.source_policies where source_code = 'greenhouse'),
  true,
  'greenhouse: display_allowed — listings appear in the candidate feed'
);
select is(
  (select automated_application_allowed from public.source_policies where source_code = 'greenhouse'),
  false,
  'greenhouse: automated_application_allowed is FALSE — reading a public board is not submission authority'
);
select is(
  (select authentication_method from public.source_policies where source_code = 'greenhouse'),
  'none',
  'greenhouse: authentication_method = none (public GET, no credential of any kind)'
);
select is(
  (select kill_switch from public.source_policies where source_code = 'greenhouse'),
  false,
  'greenhouse: kill_switch is not engaged'
);

-- --- lever ------------------------------------------------------------------
select ok(
  exists(select 1 from public.source_policies where source_code = 'lever'),
  'lever: a source_policies row exists (worker.ts throws without one)'
);
select is(
  (select discovery_allowed from public.source_policies where source_code = 'lever'),
  true,
  'lever: discovery_allowed — the postings API is public and unauthenticated'
);
select is(
  (select storage_allowed from public.source_policies where source_code = 'lever'),
  true,
  'lever: storage_allowed — listings are persisted as vacancies'
);
select is(
  (select display_allowed from public.source_policies where source_code = 'lever'),
  true,
  'lever: display_allowed — listings appear in the candidate feed'
);
select is(
  (select automated_application_allowed from public.source_policies where source_code = 'lever'),
  false,
  'lever: automated_application_allowed is FALSE — reading public postings is not submission authority'
);
select is(
  (select authentication_method from public.source_policies where source_code = 'lever'),
  'none',
  'lever: authentication_method = none (public GET, no credential of any kind)'
);
select is(
  (select kill_switch from public.source_policies where source_code = 'lever'),
  false,
  'lever: kill_switch is not engaged'
);

-- --- polled targets ---------------------------------------------------------
-- A policy row alone discovers nothing: runner.ts selects only enabled
-- vacancy_sources rows, and a source with no target is never polled.
select ok(
  exists(select 1 from public.vacancy_sources where source_code = 'greenhouse' and enabled),
  'greenhouse: at least one ENABLED polled target exists (runner.ts polls only enabled targets)'
);
select ok(
  exists(select 1 from public.vacancy_sources where source_code = 'lever' and enabled),
  'lever: at least one ENABLED polled target exists'
);

-- The adapter cannot invent a company name — Greenhouse's jobs list response
-- contains none, so greenhouse.ts reads config.companyName and validateConfig
-- THROWS when it is absent. A target missing it fails on its first run.
select ok(
  (select config->>'companyName' is not null and config->>'companyName' <> ''
   from public.vacancy_sources where source_code = 'greenhouse' and enabled order by target_key limit 1),
  'greenhouse: an enabled target config carries a non-empty companyName (validateConfig requires it)'
);
select ok(
  (select config->>'companyName' is not null and config->>'companyName' <> ''
   from public.vacancy_sources where source_code = 'lever' and enabled order by target_key limit 1),
  'lever: an enabled target config carries a non-empty companyName (validateConfig requires it)'
);

-- --- the worker's actual gate ----------------------------------------------
-- worker.ts proceeds only when discovery_allowed AND NOT kill_switch. This is
-- the single assertion that would have caught the sources being dead.
select ok(
  (select bool_and(discovery_allowed and not kill_switch)
   from public.source_policies where source_code in ('greenhouse','lever')),
  'both sources pass the discovery worker gate (discovery_allowed and not kill_switch)'
);

select * from finish();
rollback;
