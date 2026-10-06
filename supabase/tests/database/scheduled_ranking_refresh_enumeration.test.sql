-- UNEXECUTED — no isolated Postgres instance was used in this session. This file
-- documents the enumeration fixtures that MUST run against one before any claim
-- of database or RLS correctness is made. The mocked tests in
-- server/opportunities/scheduledRefresh.test.ts do NOT establish it.
--
-- Run with: supabase test db supabase/tests/database/scheduled_ranking_refresh_enumeration.test.sql
-- Requires 20261001340000 (candidate_ranking_state) and 20261001380000
-- (list_candidates_needing_ranking_refresh).
--
-- WHAT ONLY A DATABASE CAN PROVE: the enumeration actually applies
-- candidate_ranking_state, excludes failed and live-leased refreshes, orders
-- deterministically, honours the limit, and is service-role only.

begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'enum-a@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'enum-b@test.local'),
  ('33333333-3333-3333-3333-333333333333', 'enum-c@test.local'),
  ('44444444-4444-4444-4444-444444444444', 'enum-d@test.local'),
  ('55555555-5555-5555-5555-555555555555', 'enum-e@test.local'),
  ('66666666-6666-6666-6666-666666666666', 'enum-f@test.local');

insert into candidate_profiles (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444'),
  ('55555555-5555-5555-5555-555555555555'),
  ('66666666-6666-6666-6666-666666666666');

-- A, B, D, E, F select a role; C deliberately does not.
insert into candidate_selected_roles (candidate_id, role_name, raw_role_name) values
  ('11111111-1111-1111-1111-111111111111', 'Data Engineer', 'Azure Data Engineer'),
  ('22222222-2222-2222-2222-222222222222', 'Data Engineer', 'Azure Data Engineer'),
  ('44444444-4444-4444-4444-444444444444', 'Data Engineer', 'Azure Data Engineer'),
  ('55555555-5555-5555-5555-555555555555', 'Data Engineer', 'Azure Data Engineer'),
  ('66666666-6666-6666-6666-666666666666', 'Data Engineer', 'Azure Data Engineer');

-- Every role-selecting candidate has APPLICABLE role coverage. The difference is
-- the qualifier generation, which is what candidate_ranking_state keys on next.
insert into candidate_role_match_coverage
  (candidate_id, published_generation, corpus_complete, matcher_version, status, scanned, matched,
   published_corpus_version, role_input_canonical)
select
  c.id,
  gen_random_uuid(),
  true,
  'role-taxonomy-v1',
  'complete',
  0,
  0,
  (select version from public.vacancy_corpus_version),
  '[{"role_name": "Data Engineer"}]'::jsonb
from candidate_profiles c
where c.id in (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '44444444-4444-4444-4444-444444444444',
  '55555555-5555-5555-5555-555555555555',
  '66666666-6666-6666-6666-666666666666'
);

-- B is CURRENT: its qualifier generation applies and is explicitly empty (no
-- token rows), so no posting evidence is required.
insert into candidate_qualifier_generations
  (candidate_id, generation, tokenizer_version, intent_fingerprint, intent_canonical)
values (
  '22222222-2222-2222-2222-222222222222',
  gen_random_uuid(),
  'evidence-tokens-v1',
  'ifp-b',
  '[{"role_name": "Data Engineer", "raw_role_name": "Azure Data Engineer"}]'::jsonb
);

-- A and F have NO qualifier generation -> updating, and are the two the schedule
-- must find. D is the same but its refresh FAILED (explicit-retry only). E is the
-- same but a refresh is LIVE-leased right now.
insert into candidate_ranking_refresh (candidate_id, status, attempts, leased_until) values
  ('44444444-4444-4444-4444-444444444444', 'failed', 1, null),
  ('55555555-5555-5555-5555-555555555555', 'running', 0, now() + interval '10 minutes');

set local role service_role;

-- 1. The function is executable by service_role.
select ok(
  has_function_privilege('service_role', 'public.list_candidates_needing_ranking_refresh(integer)', 'EXECUTE'),
  'service_role may execute the enumeration'
);

-- 2-6. Membership.
select is(
  (select count(*)::int from public.list_candidates_needing_ranking_refresh(20)
     where candidate_id = '11111111-1111-1111-1111-111111111111'),
  1,
  'a stale candidate with selected roles is returned'
);
select is(
  (select count(*)::int from public.list_candidates_needing_ranking_refresh(20)
     where candidate_id = '22222222-2222-2222-2222-222222222222'),
  0,
  'a CURRENT candidate is not returned'
);
select is(
  (select count(*)::int from public.list_candidates_needing_ranking_refresh(20)
     where candidate_id = '33333333-3333-3333-3333-333333333333'),
  0,
  'a candidate with no selected roles is not returned'
);
select is(
  (select count(*)::int from public.list_candidates_needing_ranking_refresh(20)
     where candidate_id = '44444444-4444-4444-4444-444444444444'),
  0,
  'a FAILED refresh is excluded, so the schedule never auto-retries it'
);
select is(
  (select count(*)::int from public.list_candidates_needing_ranking_refresh(20)
     where candidate_id = '55555555-5555-5555-5555-555555555555'),
  0,
  'a live-leased refresh is excluded'
);

-- 7. Deterministic ordering across ticks.
select is(
  (select array_agg(candidate_id::text) from public.list_candidates_needing_ranking_refresh(20)),
  array['11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666'],
  'the result is ordered by candidate_id, so a capped tick resumes deterministically'
);

-- 8. The limit bounds the page, not the corpus.
select is(
  (select count(*)::int from public.list_candidates_needing_ranking_refresh(1)),
  1,
  'the limit bounds one tick'
);

-- 9. The reason is the state the caller acts on.
select is(
  (select reason from public.list_candidates_needing_ranking_refresh(20)
     where candidate_id = '11111111-1111-1111-1111-111111111111'),
  'updating',
  'the reason is the candidate_ranking_state that made it eligible'
);

reset role;

-- 10. A candidate cannot enumerate.
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111"}';
select throws_ok(
  $$select * from public.list_candidates_needing_ranking_refresh(20)$$,
  '42501',
  null,
  'authenticated cannot enumerate candidates needing refresh'
);
reset role;

select * from finish();
rollback;
