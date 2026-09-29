-- Arbeitnow — source-policy registration for the on-demand intake path.
--
-- WHY THIS ROW IS REQUIRED. server/intake refuses to run a source without a
-- source_policies row ("no source_policies row exists for it") and without a
-- vacancy_sources row, because vacancies.vacancy_source_id is a required foreign
-- key. Arbeitnow needs NO API KEY, so unlike The Muse and SerpApi there is no
-- credential to gate registration on — but the two rows are still needed, and
-- without them every candidate click would report the source as skipped.
--
-- THIS IS THE ONLY ONE OF THE FIVE AGGREGATORS ADDED SO FAR WHOSE DATA IS
-- EMPLOYER-AUTHORED. Arbeitnow's own documentation says the listings come from
-- applicant tracking systems — Greenhouse, SmartRecruiters, Join.com, Team
-- Tailor, Recruitee, Comeet — and are "direct from the employers", not scraped
-- from a search-results surface the way SerpApi's Google Jobs results are. It is
-- therefore the closest thing in the fan-out to a primary source, which is why
-- its policy row is the least contentious of the five.
--
-- COMPLIANCE DECISION STILL LEFT EXPLICIT. The API's own terms string, returned
-- in every response's meta, asks only that the source be linked back to and that
-- the API not be abused. The adapter satisfies the first — authoritativeUrl is
-- Arbeitnow's own job page, and the adapter carries a display attribution — and
-- the second by issuing exactly one request per click and never paginating. The
-- row records the review as outstanding anyway, so the position is visible in
-- the data rather than implicit.
-- ---------------------------------------------------------------------------
-- KNOWN PRODUCTION/REPOSITORY DIVERGENCE — RECORDED, NOT RESOLVED.
--
-- This migration writes automated_application_allowed = false below. The
-- production database was OBSERVED (read-only, 2026-09-29) holding TRUE for
-- arbeitnow, with updated_at = 2026-09-27T00:33:45.946+00:00.
--
-- WHAT IS KNOWN: the observed value and its timestamp; that no migration in
-- this repository sets arbeitnow to true (the only statement that sets the flag
-- true is refresh_source_application_policy(), and its loop covers greenhouse
-- and lever only); and that audit_events contains no row mentioning arbeitnow,
-- so the change left no audit record.
--
-- WHAT IS NOT KNOWN: the cause and the actor. The database does not record who
-- ran a bare UPDATE, and there is no other evidence trail. This is stated
-- plainly rather than guessed at.
--
-- WHY IT IS NOT "FIXED" HERE. Re-running this migration would not correct the
-- row anyway — it ends with ON CONFLICT DO NOTHING — and deciding the intended
-- policy is a product/compliance question (this file's own comment says the
-- aggregator has no submission channel), not a migration detail. The value is
-- left exactly as found, and no migration was written, pending that decision.
--
-- FALSE remains the only state this repository has ever asserted for arbeitnow.
-- ---------------------------------------------------------------------------
insert into public.source_policies (
  source_code,
  discovery_allowed,
  storage_allowed,
  display_allowed,
  -- An aggregator with no submission channel, so automated applications are off:
  -- there is nothing to automate against.
  automated_application_allowed,
  authentication_method,
  rate_limit,
  countries,
  policy_version,
  last_legal_review_at,
  kill_switch
)
values (
  'arbeitnow',
  true,
  true,
  true,
  false,
  -- No credential is sent at all. Recorded because it is the reason this source
  -- needs no opt-in flag while The Muse and SerpApi do.
  'none_public_api',
  -- No published numeric limit; the terms ask only that the API not be abused.
  -- The adapter's own bound is one request per click with no pagination, against
  -- a single page of 286 listings.
  'unpublished; terms ask not to abuse. Adapter issues one request per click and never paginates.',
  -- Mostly Germany, with European coverage.
  '{DE}',
  'arbeitnow-terms-acknowledged',
  null,
  false
)
on conflict (source_code) do nothing;

-- ---------------------------------------------------------------------------
-- The row the intake path needs for its foreign key.
--
-- enabled = FALSE, deliberately. This flag governs POLLING, not intake (see
-- requireVacancySourceId's own comment), so the on-demand path works either way.
-- Setting it true would hand Arbeitnow to runIngestionBatch, which would fetch
-- the full 2.34 MB board on every scheduler tick whether or not any candidate
-- asked for jobs. The scheduled worker also writes a vacancy_sources row per
-- polled target, and a whole-board feed has no target to express.
--
-- target_key names the feed itself rather than a keyword, because this API takes
-- no search parameter: it returns the newest postings and the caller filters.
insert into public.vacancy_sources (source_code, target_key, config, enabled)
values (
  'arbeitnow',
  'job-board-feed',
  '{"note": "Whole-board feed, newest first. No query parameters are supported; role filtering happens locally in the adapter."}'::jsonb,
  false
)
on conflict (source_code, target_key) do nothing;
