-- Polled targets, as data rather than as manual steps.
--
-- WHY THIS MIGRATION EXISTS. 20260902000000 (Jooble) and 20260917120000
-- (USAJOBS) each register a source_policies row, and the Jooble one
-- documents an example vacancy_sources insert that is deliberately left
-- COMMENTED OUT — "which keywords/locations to poll is a business decision
-- this migration must not make". That was the right call at the time. But it
-- left the pipeline unrunnable from a clean checkout: after a
-- \`supabase db reset\` there are zero polled targets, so the ingestion
-- worker drains an empty queue forever and the Opportunities screen stays
-- empty no matter how many times a candidate presses "Fetch latest jobs".
-- The targets had only ever been inserted by hand into one developer's local
-- database, which is exactly the kind of state that does not survive.
--
-- The decision this migration now makes explicitly, having been made once
-- already: poll US "Data Engineer" listings from both aggregators. That
-- matches the seeded candidate's confirmed current_title ("Senior Data
-- Engineer") and its selected roles, so it is a defensible default rather
-- than an arbitrary one — but it IS a product choice and should be changed
-- deliberately, not inherited by accident.
--
-- COST, because it is not refundable. Jooble's free REST plan is a lifetime
-- total of 500 requests per key (docs/JOOBLE_INTEGRATION.md §1.3). The
-- config below is 1 request per run (resultsPerPage 50 x maxPages 1), and
-- the candidate-facing refresh route additionally enforces a per-target
-- cooldown (server/ingestion/runner.ts). USAJOBS is free and unquotaed.
--
-- KNOWN LIMITATION, stated rather than hidden: maxPages 1 means only the
-- first page of Jooble's ~18,000 matches is ever tracked, and the freshness
-- sweep (ingest.ts markUnseenVacanciesExpired) expires this target's
-- vacancies that a later run does not return. With a single stable page that
-- set is the same 50 each run, so it is stable in practice — but a listing
-- that drifts off page 1 will be marked expired rather than tracked. Raising
-- maxPages costs Jooble quota linearly; the correct long-term answer is a
-- narrower keyword/location target, not a bigger page budget.
insert into public.vacancy_sources (source_code, target_key, config, enabled)
values
  (
    'jooble',
    'us-data-engineer',
    -- keywords and location are BOTH required by Jooble; country supplies
    -- vacancies.country, which the response body never contains.
    '{"keywords": "Data Engineer", "location": "United States", "country": "US", "resultsPerPage": 50, "maxPages": 1}'::jsonb,
    true
  ),
  (
    'usajobs',
    'us-data-engineer',
    -- target_key is a saved-search label only; the API call consumes
    -- keyword/locationName (see usajobs.ts's own doc comment).
    '{"keyword": "Data Engineer"}'::jsonb,
    true
  )
on conflict (source_code, target_key) do nothing;
