-- The Muse — source-policy registration for the on-demand intake path.
--
-- WHY THIS ROW IS REQUIRED. server/intake refuses to run a source without a
-- source_policies row ("no source_policies row exists for it") and without a
-- vacancy_sources row, because vacancies.vacancy_source_id is a required foreign
-- key. Registering theMuseIntakeAdapter in server/intake/adapters/registry.ts is
-- therefore only half the wiring: with THE_MUSE_INTAKE_ENABLED=true and no rows
-- here, the fan-out would report The Muse as skipped on every press of "Fetch
-- latest jobs".
--
-- THIS MIGRATION IS INERT UNTIL AN OPERATOR OPTS IN, which is the point of the
-- flag. The adapter is registered only when THE_MUSE_INTAKE_ENABLED is exactly
-- "true", and the vacancy_sources row below is enabled = false so the scheduled
-- ingestion worker does not poll it either. Nothing here starts spending The
-- Muse requests on its own.
--
-- COMPLIANCE DECISION LEFT EXPLICIT, NOT ASSUMED. The Muse's API terms govern
-- whether retrieved listings may be stored and displayed, and those terms have
-- NOT been reviewed. The row records that rather than implying a review
-- happened — policy_version = 'themuse-tou-review-pending',
-- last_legal_review_at = NULL — the same shape 20260902000000 used for Jooble
-- and 20260917350000 for Adzuna while their own reviews were outstanding.
-- Confirm the terms before public display, then update this row.
insert into public.source_policies (
  source_code,
  discovery_allowed,
  storage_allowed,
  display_allowed,
  -- An aggregator with no submission channel at all, so automated applications
  -- are doubly off: there is nothing to automate against.
  automated_application_allowed,
  authentication_method,
  rate_limit,
  countries,
  policy_version,
  last_legal_review_at,
  kill_switch
)
values (
  'themuse',
  true,
  true,
  true,
  false,
  -- The api_key is optional and travels as an ordinary query parameter
  -- (?api_key=...). Recorded because it is the reason any log line capturing a
  -- request URL would capture the credential.
  'api_key_query_param_optional',
  -- Verified against the live API's own response headers rather than taken from
  -- the docs alone: X-RateLimit-Limit returned 500 with an unauthenticated
  -- caller, and the docs state 3,600/hour once an api_key is supplied. Unlike
  -- Jooble's, this quota is HOURLY and resets, so it is not a lifetime budget to
  -- hoard.
  '500 requests/hour unauthenticated; 3600 requests/hour with an api_key (hourly, resets)',
  -- Left empty: the public jobs endpoint is not country-scoped the way Jooble's
  -- key is, and this adapter searches by free-text location instead.
  '{}',
  'themuse-tou-review-pending',
  null,
  false
)
on conflict (source_code) do nothing;

-- ---------------------------------------------------------------------------
-- The row the intake path needs for its foreign key.
--
-- enabled = FALSE, deliberately. This flag governs POLLING, not intake (see
-- requireVacancySourceId's own comment), so the on-demand path works either way.
-- Setting it true would additionally hand The Muse to runIngestionBatch, which
-- would spend requests on every scheduler tick whether or not any candidate
-- asked for jobs — the opposite of what an on-demand source is for, and the same
-- reasoning the Remotive and Adzuna migrations recorded.
--
-- target_key is a stable operator label; The Muse consumes no target identifier.
-- The config records the location a scheduled target would poll, which the
-- on-demand adapter supplies per candidate instead (from the confirmed location
-- fact). It is a starting point for a scheduled target, not a commitment: which
-- market to poll on a schedule is a business decision this migration must not
-- make on its own.
insert into public.vacancy_sources (source_code, target_key, config, enabled)
values (
  'themuse',
  'us-remote',
  '{"location": "Remote", "resultsPerPage": 20}'::jsonb,
  false
)
on conflict (source_code, target_key) do nothing;
