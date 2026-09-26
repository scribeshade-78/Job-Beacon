-- SerpApi (Google Jobs) — source-policy registration for the on-demand intake path.
--
-- WHY THIS ROW IS REQUIRED. server/intake refuses to run a source without a
-- source_policies row ("no source_policies row exists for it") and without a
-- vacancy_sources row, because vacancies.vacancy_source_id is a required foreign
-- key. Registering serpapiIntakeAdapter in server/intake/adapters/registry.ts is
-- therefore only half the wiring.
--
-- THIS MIGRATION IS INERT UNTIL AN OPERATOR OPTS IN, twice over. The adapter is
-- registered only when SERPAPI_INTAKE_ENABLED is exactly "true" AND a non-blank
-- SERPAPI_API_KEY exists; the vacancy_sources row below is enabled = false so the
-- scheduled ingestion worker does not poll it either. Nothing here starts
-- spending searches on its own.
--
-- COMPLIANCE DECISION LEFT EXPLICIT, NOT ASSUMED. SerpApi's terms govern whether
-- retrieved listings may be stored and displayed, and whether Google Jobs
-- results may be redistributed at all. That review has NOT happened, and the row
-- records that rather than implying otherwise — policy_version =
-- 'serpapi-tou-review-pending', last_legal_review_at = NULL — the same shape
-- 20260902000000 used for Jooble, 20260917350000 for Adzuna and 20260917360000
-- for The Muse while their own reviews were outstanding. THIS ONE IS WORTH
-- TREATING AS A HARDER QUESTION than the others: the data originates with
-- Google, is resold by SerpApi, and is a scrape of a search-results surface
-- rather than a publisher's own feed.
insert into public.source_policies (
  source_code,
  discovery_allowed,
  storage_allowed,
  display_allowed,
  -- An aggregator of aggregators with no submission channel, so automated
  -- applications are off twice over: there is nothing to automate against.
  automated_application_allowed,
  authentication_method,
  rate_limit,
  countries,
  policy_version,
  last_legal_review_at,
  kill_switch
)
values (
  'serpapi',
  true,
  true,
  true,
  false,
  -- The key travels as an ordinary query parameter on the search URL
  -- (?api_key=...), so any log line capturing a request URL captures the
  -- credential. Recorded because that is why the adapter names only its base
  -- endpoint in errors.
  'api_key_query_param',
  -- The tightest budget in the fan-out by two orders of magnitude: Jooble is 500
  -- LIFETIME, The Muse 500 HOURLY. One candidate pressing the button ten times
  -- would spend ten percent of a month.
  '100 searches per month (free tier); one button press costs exactly one search',
  -- Left empty: google_jobs is not country-scoped the way Jooble''s key is. The
  -- adapter sends gl=in / hl=en (India-first) and narrows with the candidate''s
  -- confirmed location.
  '{}',
  'serpapi-tou-review-pending',
  null,
  false
)
on conflict (source_code) do nothing;

-- ---------------------------------------------------------------------------
-- The row the intake path needs for its foreign key.
--
-- enabled = FALSE, deliberately. This flag governs POLLING, not intake (see
-- requireVacancySourceId's own comment), so the on-demand path works either way.
-- Setting it true would hand SerpApi to runIngestionBatch and spend searches on
-- every scheduler tick whether or not any candidate asked for jobs — against a
-- 100-per-month budget that would exhaust the account within hours.
--
-- target_key is a stable operator label; SerpApi consumes no target identifier.
-- The config records the query a scheduled target would send. It is a starting
-- point, not a commitment: which market and keywords to poll on a schedule is a
-- business decision this migration must not make on its own, and the on-demand
-- adapter builds its own single combined query per click instead.
insert into public.vacancy_sources (source_code, target_key, config, enabled)
values (
  'serpapi',
  'in-data-engineer',
  '{"engine": "google_jobs", "q": "Data Engineer", "location": "India", "gl": "in", "hl": "en"}'::jsonb,
  false
)
on conflict (source_code, target_key) do nothing;
