begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

-- Fixture setup (as postgres, bypasses RLS — not under test; the
-- application_plans/application_attempts grants/RLS this fixture also
-- touches are covered in their own *_rls.test.sql files).
insert into auth.users (id, email) values ('11111111-9000-1111-1111-111111111111', 'candidate-a@test.local');
insert into candidate_profiles (id) values ('11111111-9000-1111-1111-111111111111');
-- R7-M4: claim_application_attempt's cancellation sweep now checks
-- automation_authorizations for every candidate whose attempt it might
-- claim. Candidate A must be 'authorized' for tests 3-8 below (all
-- written before R7-M4, testing ordinary leasing/retry/FIFO behavior) to
-- keep exercising that behavior rather than having every attempt swept
-- into 'cancelled' before it can be leased at all.
insert into automation_authorizations (candidate_id, status, consent_version)
values ('11111111-9000-1111-1111-111111111111', 'authorized', 'r1-v1');
insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('greenhouse', 'none', 'r2-v1', array['US']);
insert into companies (id, displayed_name, domain)
values ('cccccccc-9000-1111-1111-111111111111', 'Applyco', 'applyco.example');
insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-9000-1111-1111-111111111111', 'greenhouse', 'applyco');
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
values ('eeeeeeee-9000-1111-1111-111111111111', 'greenhouse', 'dddddddd-9000-1111-1111-111111111111', 'job-worker-1', 'https://applyco.example/jobs/1', 'Worker Test Role', 'cccccccc-9000-1111-1111-111111111111');
insert into application_plans (id, candidate_id, vacancy_id, gate_results)
values ('ffffffff-9000-1111-1111-111111111111', '11111111-9000-1111-1111-111111111111', 'eeeeeeee-9000-1111-1111-111111111111', '{}'::jsonb);

-- R7-M4 fixtures (candidates B and C, used by tests 10-15 below): inserted
-- here, alongside candidate A's, rather than down near the tests that use
-- them, because auth.users can only be written under the script's default
-- connecting role (effectively superuser) — service_role has no INSERT on
-- auth.users (real user creation goes through Auth's admin API, not raw
-- SQL as service_role), and `set local role service_role;` below is in
-- effect for the rest of the script after test 2.
insert into auth.users (id, email) values ('22222222-9000-1111-1111-111111111111', 'candidate-b-paused@test.local');
insert into candidate_profiles (id) values ('22222222-9000-1111-1111-111111111111');
insert into automation_authorizations (candidate_id, status, consent_version)
values ('22222222-9000-1111-1111-111111111111', 'paused', 'r1-v1');
insert into application_plans (id, candidate_id, vacancy_id, gate_results)
values ('ffffffff-9001-1111-1111-111111111111', '22222222-9000-1111-1111-111111111111', 'eeeeeeee-9000-1111-1111-111111111111', '{}'::jsonb);
insert into application_attempts (id, application_plan_id)
values ('55555555-8000-2222-2222-222222222222', 'ffffffff-9001-1111-1111-111111111111');

insert into auth.users (id, email) values ('33333333-9000-1111-1111-111111111111', 'candidate-c-stopped@test.local');
insert into candidate_profiles (id) values ('33333333-9000-1111-1111-111111111111');
insert into automation_authorizations (candidate_id, status, consent_version)
values ('33333333-9000-1111-1111-111111111111', 'stopped', 'r1-v1');
insert into application_plans (id, candidate_id, vacancy_id, gate_results)
values ('ffffffff-9002-1111-1111-111111111111', '33333333-9000-1111-1111-111111111111', 'eeeeeeee-9000-1111-1111-111111111111', '{}'::jsonb);
insert into application_attempts (id, application_plan_id)
values ('66666666-8000-2222-2222-222222222222', 'ffffffff-9002-1111-1111-111111111111');

-- 1. anon cannot execute claim_application_attempt
set local role anon;
select throws_ok(
  $$select * from claim_application_attempt()$$,
  '42501',
  null,
  'anon cannot execute claim_application_attempt'
);
reset role;

-- 2. authenticated cannot execute claim_application_attempt
set local role authenticated;
select throws_ok(
  $$select * from claim_application_attempt()$$,
  '42501',
  null,
  'authenticated candidate cannot execute claim_application_attempt'
);
reset role;

set local role service_role;

insert into application_attempts (id, application_plan_id)
values ('11111111-8000-2222-2222-222222222222', 'ffffffff-9000-1111-1111-111111111111');

-- 3. service_role claims the pending attempt
select results_eq(
  $$select id, status, attempts from claim_application_attempt()$$,
  $$values ('11111111-8000-2222-2222-222222222222'::uuid, 'leased'::text, 1)$$,
  'service_role claims the pending attempt, marking it leased with attempts incremented'
);

-- 4. the same attempt is not claimable again immediately (lease still active)
select is_empty(
  $$select id from claim_application_attempt()$$,
  'A freshly-leased attempt is not claimable again while its lease is active'
);

-- 5. once the lease expires, the same attempt becomes claimable again
update application_attempts set leased_until = now() - interval '1 minute'
  where id = '11111111-8000-2222-2222-222222222222';
select results_eq(
  $$select id, attempts from claim_application_attempt()$$,
  $$values ('11111111-8000-2222-2222-222222222222'::uuid, 2)$$,
  'An attempt with an expired lease is reclaimed, incrementing attempts again'
);

-- 6. an attempt that has exhausted max_attempts is never claimed
update application_attempts
  set attempts = max_attempts, leased_until = now() - interval '1 minute'
  where id = '11111111-8000-2222-2222-222222222222';
select is_empty(
  $$select id from claim_application_attempt()$$,
  'An attempt at max_attempts is not claimed — dead-letter behavior'
);

-- 7. an attempt already marked succeeded is never reclaimed even with a stale lease
update application_attempts
  set status = 'succeeded', attempts = 1, leased_until = now() - interval '1 minute'
  where id = '11111111-8000-2222-2222-222222222222';
select is_empty(
  $$select id from claim_application_attempt()$$,
  'A succeeded attempt is never reclaimed regardless of leased_until'
);

-- 8. two attempts: only the oldest pending one is claimed (FIFO by created_at)
insert into application_attempts (id, application_plan_id, created_at)
values
  ('33333333-8000-2222-2222-222222222222', 'ffffffff-9000-1111-1111-111111111111', now() - interval '2 minutes'),
  ('44444444-8000-2222-2222-222222222222', 'ffffffff-9000-1111-1111-111111111111', now() - interval '1 minute');
select results_eq(
  $$select id from claim_application_attempt()$$,
  $$values ('33333333-8000-2222-2222-222222222222'::uuid)$$,
  'The oldest pending attempt is claimed first (FIFO)'
);

-- 9. no privileges leaked to authenticated/anon on the underlying table by this function
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'application_attempts' and grantee in ('anon', 'authenticated') and privilege_type != 'SELECT'$$,
  'Neither anon nor authenticated gained any mutation privilege on application_attempts from the RPC'
);

-- R7-M4: candidate authorization withdrawal (pause/stop) tests below,
-- using the candidate B/C fixtures inserted up front (see above, next to
-- candidate A's). Leftover claimable rows from tests 1-8 (candidate A's
-- still-'pending' attempt from test 8) are forced terminal first, so every
-- claim_application_attempt() call from here on only ever sees this file's
-- own fixture rows — deterministic, not dependent on prior test state.
update application_attempts set status = 'succeeded' where status in ('pending', 'leased');

-- 10. the paused candidate's pending attempt is never claimed
select is_empty(
  $$select id from claim_application_attempt() where id = '55555555-8000-2222-2222-222222222222'::uuid$$,
  'A pending attempt for a paused candidate is never claimed'
);

-- 11. it is cancelled by the sweep instead, with attempts left untouched
select results_eq(
  $$select status, attempts from application_attempts where id = '55555555-8000-2222-2222-222222222222'::uuid$$,
  $$values ('cancelled'::text, 0)$$,
  'The paused candidate''s attempt is cancelled by the sweep, with attempts left at 0 (never leased, never incremented)'
);

-- 12. the stopped candidate's pending attempt is never claimed
select is_empty(
  $$select id from claim_application_attempt() where id = '66666666-8000-2222-2222-222222222222'::uuid$$,
  'A pending attempt for a stopped candidate is never claimed'
);

-- 13. it is cancelled by the sweep instead, with attempts left untouched
select results_eq(
  $$select status, attempts from application_attempts where id = '66666666-8000-2222-2222-222222222222'::uuid$$,
  $$values ('cancelled'::text, 0)$$,
  'The stopped candidate''s attempt is cancelled by the sweep, with attempts left at 0'
);

-- 14. re-authorizing the candidate afterward does not resurrect a
-- cancelled attempt — 'cancelled' matches neither claim of the leasing
-- query's WHERE clause, so it is a genuinely terminal state.
--
-- This UPDATE simulates the candidate's own resume() action (client/src/lib/automationAuthorization.ts),
-- which runs as `authenticated` in production — not service_role, which
-- (correctly) only has SELECT on automation_authorizations. Reset to the
-- script's default role for just this one fixture mutation, then switch
-- back to service_role, since claim_application_attempt() below still
-- requires it.
reset role;
update automation_authorizations set status = 'authorized'
  where candidate_id = '22222222-9000-1111-1111-111111111111';
set local role service_role;
select is_empty(
  $$select id from claim_application_attempt() where id = '55555555-8000-2222-2222-222222222222'::uuid$$,
  'A cancelled attempt is never claimed again, even after the candidate re-authorizes'
);

-- 15. meanwhile, an authorized candidate's pending attempt in the same
-- batch is claimed normally — the sweep is selective, not a blanket halt.
insert into application_attempts (id, application_plan_id)
values ('77777777-8000-2222-2222-222222222222', 'ffffffff-9000-1111-1111-111111111111');
select results_eq(
  $$select id, status, attempts from claim_application_attempt()$$,
  $$values ('77777777-8000-2222-2222-222222222222'::uuid, 'leased'::text, 1)$$,
  'An authorized candidate''s pending attempt is claimed normally even while other candidates'' attempts are being cancelled'
);

-- 16. the CHECK constraint accepts 'cancelled' as a valid status
select lives_ok(
  $$insert into application_attempts (id, application_plan_id, status)
      values ('88888888-8000-2222-2222-222222222222', 'ffffffff-9000-1111-1111-111111111111', 'cancelled')$$,
  'application_attempts.status accepts ''cancelled'''
);

-- 17. the CHECK constraint still rejects an arbitrary invalid status
select throws_ok(
  $$insert into application_attempts (id, application_plan_id, status)
      values ('99999999-8000-2222-2222-222222222222', 'ffffffff-9000-1111-1111-111111111111', 'bogus_status')$$,
  '23514',
  null,
  'application_attempts.status still rejects an arbitrary invalid value'
);

-- ---------------------------------------------------------------------------
-- Task U: the review gate.
--
-- The gate is enforced by the leasing query being an ALLOWLIST over 'pending'
-- — a 'pending_review' row matches no clause of it. That is a property of the
-- SQL text, and reading the SQL is not evidence; these assertions run it.
-- ---------------------------------------------------------------------------

-- Every leftover attempt from the tests above is forced terminal first, so the
-- claims below can only ever see this block's own fixture rows. Without this,
-- "the held attempt was not claimed" would pass whenever the function happened
-- to claim some other row instead.
update application_attempts set status = 'succeeded'
  where status in ('pending', 'pending_review', 'leased');

-- 18. the CHECK constraint accepts the new status
select lives_ok(
  $$insert into application_attempts (id, application_plan_id, status)
      values ('aaaaaaaa-8000-2222-2222-222222222222', 'ffffffff-9000-1111-1111-111111111111', 'pending_review')$$,
  'application_attempts.status accepts ''pending_review'''
);

-- Candidate A is authorized throughout, so the sweep cannot be what spares
-- this row — the leasing query alone has to refuse it.
--
-- 19. the held attempt is not claimed
select is_empty(
  $$select id from claim_application_attempt()$$,
  'A pending_review attempt is never claimed, even though it is the only non-terminal attempt'
);

-- 20. and it was not quietly leased or partly advanced on the way past
select results_eq(
  $$select status, attempts, leased_until from application_attempts
      where id = 'aaaaaaaa-8000-2222-2222-222222222222'::uuid$$,
  $$values ('pending_review'::text, 0, null::timestamptz)$$,
  'The held attempt is left completely untouched by a claim: still pending_review, attempts still 0, never leased'
);

-- 21. approving it — the transition POST /api/worker/approve-attempt performs —
-- is what makes it claimable. Nothing else changed.
update application_attempts
  set status = 'pending', review_approved_at = now()
  where id = 'aaaaaaaa-8000-2222-2222-222222222222' and status = 'pending_review';

select results_eq(
  $$select id, status, attempts from claim_application_attempt()$$,
  $$values ('aaaaaaaa-8000-2222-2222-222222222222'::uuid, 'leased'::text, 1)$$,
  'Once approved, the same attempt is claimed normally and leased'
);

-- 22. review_approved_at was never set on a path that did not approve anything
-- (the row inserted for candidate C below is never approved).
-- Candidate C is 'stopped' (fixture above), so this row is also the sweep test.
insert into application_attempts (id, application_plan_id, status)
values ('bbbbbbbb-8000-2222-2222-222222222222', 'ffffffff-9002-1111-1111-111111111111', 'pending_review');

select is_empty(
  $$select id from claim_application_attempt() where id = 'bbbbbbbb-8000-2222-2222-222222222222'::uuid$$,
  'An attempt held for review on a stopped candidate is still never claimed'
);

-- 23. the sweep cancels it, so the review queue does not keep offering work
-- that can no longer happen.
select results_eq(
  $$select status, review_approved_at from application_attempts
      where id = 'bbbbbbbb-8000-2222-2222-222222222222'::uuid$$,
  $$values ('cancelled'::text, null::timestamptz)$$,
  'A held attempt for a stopped candidate is cancelled by the sweep, with review_approved_at still null'
);

reset role;

select * from finish();
rollback;
