-- Jooble (REST API, aggregator tier) — source-policy registration.
--
-- WHY THIS ROW IS REQUIRED: server/ingestion/worker.ts refuses to run a
-- discovery job unless source_policies has a matching row
-- ("source_policies row for \"jooble\" not found"), and vacancy_sources.source_code
-- has a foreign key onto this table. Registering the adapter in TypeScript
-- (server/ingestion/adapters/registry.ts) is therefore only half the wiring —
-- without this row a queued Jooble ingestion job fails immediately.
--
-- COMPLIANCE DECISION LEFT EXPLICIT, NOT ASSUMED: Jooble's API terms govern
-- whether retrieved listings may be stored and displayed, and the free plan is
-- a lifetime quota of 500 requests per key. The values below enable the
-- minimum this pipeline needs and are marked unreviewed
-- (policy_version = 'jooble-tou-review-pending', last_legal_review_at = NULL)
-- so the outstanding review is visible in the data rather than forgotten.
-- Confirm the terms before public display, then update this row.
--
-- Source-policy rows are not seeded for any other provider in this repository;
-- this one is included because Jooble's per-key lifetime quota plus its
-- URL-path credential make an unreviewed default materially riskier than for
-- the other aggregators.
insert into public.source_policies (
  source_code,
  discovery_allowed,
  storage_allowed,
  display_allowed,
  -- Automated applications stay OFF for every source in R2 (PRD §28 scopes
  -- them to R4). Jooble is an aggregator with no submission channel at all,
  -- so this is doubly required.
  automated_application_allowed,
  authentication_method,
  rate_limit,
  countries,
  policy_version,
  last_legal_review_at,
  kill_switch
)
values (
  'jooble',
  true,
  true,
  true,
  false,
  -- The credential travels in the request URL path, not a header:
  -- POST https://jooble.org/api/{JOOBLE_API_KEY}. Recorded here because it is
  -- the reason redaction (not just "don't print the header") is required.
  'api_key_in_url_path',
  'Free plan: 500 requests per key, lifetime total (not monthly). Retries and page fetches each consume one.',
  -- Left empty on purpose: the key is country-scoped and only the operator
  -- knows which domain issued it (jooble.org => US, uk.jooble.org => UK, ...).
  -- Set this to the countries the configured key actually covers, e.g. '{US}'.
  '{}',
  'jooble-tou-review-pending',
  null,
  false
)
on conflict (source_code) do nothing;

-- ---------------------------------------------------------------------------
-- Example polled target. Deliberately NOT inserted: which keywords/locations
-- to poll is a business decision this migration must not make, and an
-- unreviewed target would start spending the 500-request lifetime quota on
-- its first scheduled run. Uncomment and edit once the policy row above has
-- been reviewed.
-- ---------------------------------------------------------------------------
-- insert into public.vacancy_sources (source_code, target_key, config, enabled)
-- values (
--   'jooble',
--   -- Operator-chosen stable label; Jooble consumes no target identifier.
--   'us-sales-manager-remote',
--   -- keywords and location are BOTH required by Jooble. country supplies
--   -- vacancies.country, which the response body never contains. Keep
--   -- maxPages * ResultOnPage >= the expected totalCount, otherwise a
--   -- truncated run lets the freshness sweep expire unfetched vacancies —
--   -- see docs/JOOBLE_INTEGRATION.md.
--   '{"keywords": "Sales Manager", "location": "United States", "country": "US", "resultsPerPage": 100, "maxPages": 1}'::jsonb,
--   false
-- )
-- on conflict (source_code, target_key) do nothing;
