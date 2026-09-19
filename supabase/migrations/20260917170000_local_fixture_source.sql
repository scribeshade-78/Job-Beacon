-- Mini-Phase 8 — the local fixture submission target.
--
-- WHY THIS EXISTS. A first submission adapter needs somewhere to submit TO,
-- and neither source with data in this repository can be that target:
--
--   * Jooble is an aggregator with no application channel at all — its
--     payload is id/link/title/company/snippet and its link is a
--     jooble.org/jdp/ redirect that returns 403 to any server-side request.
--   * USAJOBS requires a USAJOBS account login, and its stored HowToApply
--     text on the seeded postings reads "This post is for viewing purposes
--     only. To get started, please visit https://www.cia.gov/careers/".
--
-- Both also carry automated_application_allowed = false with
-- policy_version '*-tou-review-pending' and last_legal_review_at = NULL, so
-- neither has had the terms review that switching automated submission on
-- would require.
--
-- So this seeds a source that submits nowhere: 'local_fixture' points at the
-- Express server's own /mock-employer/apply route. It exercises registry ->
-- eligibility gate -> worker -> state transitions end to end without
-- touching a third-party system.
--
-- DISCOVERY_ALLOWED IS TRUE ON PURPOSE — NOT AN OVERSIGHT.
-- evaluateSourcePolicy passes only when discovery_allowed AND
-- automated_application_allowed are both true; it is an AND, not "either
-- permission". A fixture source has nothing to discover, so false would be
-- the semantically tidy value — and it would make the gate fail, defeating
-- the entire point of this seed. True here means "this source's policy
-- permits the pipeline to act on it". Nothing is polled: the vacancy_sources
-- row below is disabled, which is what actually prevents discovery.
--
-- last_legal_review_at is set to now() honestly: the "terms" for this source
-- are that it posts to localhost and submits nothing externally. That is a
-- review that genuinely happened, unlike the two aggregators above.
insert into public.source_policies (
  source_code,
  discovery_allowed,
  storage_allowed,
  display_allowed,
  automated_application_allowed,
  authentication_method,
  rate_limit,
  countries,
  policy_version,
  last_legal_review_at,
  kill_switch
)
values (
  'local_fixture',
  true,
  true,
  true,
  true,
  'none',
  null,
  '{XX}',
  'local-fixture-v1',
  now(),
  false
)
on conflict (source_code) do nothing;

-- enabled = false: this target is never polled. The row exists only because
-- vacancies.vacancy_source_id is a NOT NULL foreign key.
insert into public.vacancy_sources (source_code, target_key, config, enabled)
values ('local_fixture', 'local-fixture-board', '{}'::jsonb, false)
on conflict (source_code, target_key) do nothing;

-- trust_status must be VERIFIED (or VERIFIED_INCOMPLETE): those two are
-- VACANCY_TRUST_ELIGIBLE_STATUSES, the set the vacancy_trust gate checks.
-- "eligible" is not a value this column has.
--
-- authoritative_url points at the Express server's mock route — PORT defaults
-- to 5000 (server/index.ts). If the server runs on another port, update these
-- three rows; the adapter navigates to whatever authoritative_url holds.
--
-- Titles are prefixed [MOCK] and contain a role the seeded candidate has
-- selected, so role_match passes — and so these are unmistakable if they
-- surface in the candidate-facing Opportunities list, which filters on
-- status = 'active'.
with target as (
  select id from public.vacancy_sources
  where source_code = 'local_fixture' and target_key = 'local-fixture-board'
)
insert into public.vacancies (
  source_code,
  vacancy_source_id,
  source_vacancy_id,
  authoritative_url,
  raw_title,
  country,
  status,
  trust_status
)
select
  'local_fixture',
  target.id,
  v.source_vacancy_id,
  v.authoritative_url,
  v.raw_title,
  'XX',
  'active',
  'VERIFIED'
from target
cross join (
  values
    ('local-fixture-1', 'http://127.0.0.1:5000/mock-employer/apply?posting=1', '[MOCK] Data Engineer — Local Fixture'),
    ('local-fixture-2', 'http://127.0.0.1:5000/mock-employer/apply?posting=2', '[MOCK] Data Analyst — Local Fixture'),
    ('local-fixture-3', 'http://127.0.0.1:5000/mock-employer/apply?posting=3', '[MOCK] Software Engineer — Local Fixture')
) as v (source_vacancy_id, authoritative_url, raw_title)
on conflict do nothing;
