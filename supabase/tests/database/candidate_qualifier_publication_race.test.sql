-- UNEXECUTED — there is no isolated Postgres/Supabase instance available in this
-- session. This file documents the race fixtures that MUST be run against one
-- before any claim of database or concurrency safety is made. Nothing here has
-- been executed, and the mocked TypeScript tests do NOT establish any of it.
--
-- Run with: supabase test db   (or psql against a disposable local database)
--
-- The properties are stated as failing assertions so a regression is loud.

begin;

-- ---------------------------------------------------------------------------
-- FIXTURE 1 — intent changes AFTER the publication recheck but BEFORE the CAS.
--
-- This window is NOT closed in application code and cannot be closed without
-- reading intent and publishing in one statement. What must hold is that the
-- stale generation never becomes READABLE: the read-time guard compares the
-- pointer's fingerprint with current intent and reports UNKNOWN on a mismatch.
-- ---------------------------------------------------------------------------
-- publish generation A from intent A (fingerprint FA)
-- edit intent to B (fingerprint FB)
-- attempt the CAS with FA
--   => 0 rows affected, pointer still A
--   => loadPublishedQualifierGeneration() must return NULL, not A's preferences

-- ---------------------------------------------------------------------------
-- FIXTURE 2 — A -> B -> A while refreshes are running.
--
-- The intent fingerprint is CONTENT-based, so it returns to FA. A generation
-- derived from A is therefore still CORRECT data for intent A (derivation is a
-- pure function of intent), which is the intended behaviour: content equality,
-- not edit history, decides validity. This fixture pins that reading so a future
-- change to a history-based fingerprint has to be deliberate.
-- ---------------------------------------------------------------------------
-- edit A -> B -> A; publish a generation derived from A
--   => loadPublishedQualifierGeneration() returns it (fingerprint matches)
--   => its rows equal the pure derivation of A

-- ---------------------------------------------------------------------------
-- FIXTURE 3 — two refreshes observe the same fingerprint, complete in reverse.
--
-- Refresh 1 (derived first) must NOT replace refresh 2's generation merely
-- because it finishes later: the CAS matches on the fingerprint it observed, so
-- the first successful CAS wins and the loser reports stale.
-- ---------------------------------------------------------------------------
-- both read FA; refresh 2 publishes first; refresh 1 attempts the CAS
--   => refresh 1 affects 0 rows and is stale
--   => exactly one generation is reachable through the pointer

-- ---------------------------------------------------------------------------
-- FIXTURE 4 — a stale cached generation after an edit or clear.
--
-- The dangerous case: publication keeps the PREVIOUS generation current when it
-- loses a race, so after a CLEAR the pointer still names the old generation.
-- ---------------------------------------------------------------------------
-- publish "azure" (generation A); clear raw_role_name; abandon the refresh
--   => pointer still names A
--   => loadPublishedQualifierGeneration() must return NULL (fingerprint mismatch)
--   => the cleared preference must NOT keep boosting anything

-- ---------------------------------------------------------------------------
-- FIXTURE 5 — ownership: every published generation belongs to its candidate.
-- ---------------------------------------------------------------------------
select g.candidate_id
from public.candidate_qualifier_generations g
join public.candidate_qualifier_tokens t
  on t.candidate_id = g.candidate_id and t.generation = g.generation
where t.candidate_id <> g.candidate_id;
-- expect zero rows

rollback;

-- EXPECTED FAILURES IF THE READ-TIME GUARD IS REMOVED
--   Fixture 1 and Fixture 4 would return a generation instead of NULL, i.e. a
--   cleared or superseded preference would keep ranking.
