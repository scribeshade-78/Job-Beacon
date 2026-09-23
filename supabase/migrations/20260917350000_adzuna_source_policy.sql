-- Adzuna (Jobs Search API, aggregator tier) — source-policy registration.
--
-- WHY THIS ROW IS REQUIRED, and it is not the same reason as Jooble's. Adzuna is
-- driven here by the ON-DEMAND intake path (server/intake), which refuses to run
-- a source without a source_policies row ("no source_policies row exists for it")
-- and without a vacancy_sources row, because vacancies.vacancy_source_id is a
-- required foreign key. Registering adzunaIntakeAdapter in
-- server/intake/adapters/registry.ts is therefore only half the wiring: without
-- these rows the fan-out reports Adzuna as skipped on every single press of
-- "Fetch latest jobs".
--
-- COMPLIANCE DECISION LEFT EXPLICIT, NOT ASSUMED. Adzuna's API terms govern
-- whether retrieved listings may be stored and displayed, and those terms have
-- NOT been reviewed. The row therefore records that fact rather than implying a
-- review happened: policy_version = 'adzuna-tou-review-pending' and
-- last_legal_review_at = NULL, the same shape 20260902000000 used for Jooble
-- while its own review was outstanding. Confirm the terms before public display,
-- then update this row.
--
-- rate_limit IS NULL ON PURPOSE. Adzuna's published quota was not verified while
-- writing this, and a plausible-looking number in a policy column is worse than
-- an empty one — it would be cited later as if it had been checked. Record the
-- real figure when someone reads it off the developer portal.
insert into public.source_policies (
  source_code,
  discovery_allowed,
  storage_allowed,
  display_allowed,
  -- Automated applications stay OFF, and for Adzuna that is doubly required:
  -- it is an aggregator with no submission channel at all, so there is nothing
  -- to automate against. evaluateSourcePolicy is (discovery_allowed AND
  -- automated_application_allowed), so these vacancies are discoverable and
  -- displayable but never appliable.
  automated_application_allowed,
  authentication_method,
  rate_limit,
  countries,
  policy_version,
  last_legal_review_at,
  kill_switch
)
values (
  'adzuna',
  true,
  true,
  true,
  false,
  -- The app_id/app_key pair travels as QUERY PARAMETERS on the search URL
  -- (/v1/api/jobs/{country}/search/1?app_id=...&app_key=...), not in a header —
  -- so, as with Jooble, any log line capturing the URL captures the credential.
  'api_key_query_params',
  null,
  -- Left empty: only the operator knows which national markets the configured
  -- key pair is entitled to. Set this to the countries it covers, e.g. '{GB}'.
  '{}',
  'adzuna-tou-review-pending',
  null,
  false
)
on conflict (source_code) do nothing;

-- ---------------------------------------------------------------------------
-- The row the intake path needs for its foreign key.
--
-- enabled = FALSE, and that is deliberate rather than an oversight. This flag
-- governs POLLING, not intake (see requireVacancySourceId's own comment), so
-- intake works either way. Setting it true would additionally hand Adzuna to
-- runIngestionBatch, which would spend Adzuna requests on every scheduler tick
-- whether or not any candidate asked for jobs — the opposite of what an
-- on-demand source is for, and the same reasoning
-- 20260917210000_remotive_intake_source.sql recorded for Remotive.
--
-- target_key IS the country code for Adzuna: its country is a URL path segment
-- ("/jobs/{country}/search/1"), so unlike Jooble there is no country field in
-- the config — targetKey carries it. See adzuna.ts's own doc comment.
--
-- The config records the `what` this target would poll, which today is the same
-- role-keyword string the on-demand path sends. It is a starting point for a
-- scheduled target, not a commitment: which market to poll on a schedule is a
-- business decision this migration must not make on its own. Change the country
-- by editing target_key, or add further rows for other markets.
insert into public.vacancy_sources (source_code, target_key, config, enabled)
values (
  'adzuna',
  'us',
  '{"what": "Data Engineer", "resultsPerPage": 50}'::jsonb,
  false
)
on conflict (source_code, target_key) do nothing;
