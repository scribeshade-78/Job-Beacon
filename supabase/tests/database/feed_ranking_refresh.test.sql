-- UNEXECUTED — no isolated Postgres/Supabase instance is available in this
-- session. This file documents the lease and lifecycle fixtures that MUST run
-- against one before any claim of database, RLS or concurrency correctness is
-- made. Nothing here has been executed, and the mocked TypeScript tests are NOT
-- database or concurrency verification.
--
-- Run with: supabase test db   (or psql against a disposable local database)
-- Requires 20261001360000_feed_ranking_refresh.sql.
--
-- WHAT ONLY A DATABASE CAN PROVE:
--   * the singleton posting-index lease actually excludes a second claim;
--   * the per-candidate lease excludes duplicate concurrent work;
--   * a live lease is not clobbered by request(force => true);
--   * a failed refresh is NOT auto-retried, while an explicit retry re-arms it;
--   * attempts count failures, not continuation steps;
--   * candidates can read only their own refresh row and can write nothing.

begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users (id, email) values
  ('a1a1a1a1-1111-1111-1111-111111111111', 'refresh-a@test.local'),
  ('b2b2b2b2-2222-2222-2222-222222222222', 'refresh-b@test.local');

insert into candidate_profiles (id) values
  ('a1a1a1a1-1111-1111-1111-111111111111'),
  ('b2b2b2b2-2222-2222-2222-222222222222');

-- ---------------------------------------------------------------------------
-- 1-4. Access model.
-- ---------------------------------------------------------------------------
select ok(
  (select relrowsecurity from pg_class where oid = 'public.candidate_ranking_refresh'::regclass),
  'RLS is enabled on candidate_ranking_refresh'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.posting_evidence_index_state'::regclass),
  'RLS is enabled on posting_evidence_index_state'
);
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'candidate_ranking_refresh' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has EXACTLY SELECT on its own refresh row'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'posting_evidence_index_state' and grantee = 'authenticated'$$,
  'authenticated has no privilege on the shared posting-index state'
);

-- ---------------------------------------------------------------------------
-- 5-7. Request, claim, and the lease excluding a duplicate.
-- ---------------------------------------------------------------------------
set local role service_role;

select is(
  (select status from public.request_candidate_ranking_refresh('a1a1a1a1-1111-1111-1111-111111111111', true)),
  'pending',
  'request(force) arms a pending refresh'
);
select is(
  (select count(*)::int from public.claim_candidate_ranking_refresh('a1a1a1a1-1111-1111-1111-111111111111')),
  1,
  'claim returns the armed row'
);
select is(
  (select count(*)::int from public.claim_candidate_ranking_refresh('a1a1a1a1-1111-1111-1111-111111111111')),
  0,
  'a second concurrent claim returns nothing — the lease excludes duplicate work'
);

-- 8. A live lease is not clobbered by a role save.
select is(
  (select status from public.request_candidate_ranking_refresh('a1a1a1a1-1111-1111-1111-111111111111', true)),
  'running',
  'request(force) does NOT interrupt an in-flight refresh'
);

-- 9-10. A continuation releases the lease without consuming an attempt.
select is(
  (select status from public.finish_candidate_ranking_refresh('a1a1a1a1-1111-1111-1111-111111111111', 'pending', null)),
  'pending',
  'finish(pending) records a continuation'
);
select is(
  (select attempts from public.candidate_ranking_refresh where candidate_id = 'a1a1a1a1-1111-1111-1111-111111111111'),
  0,
  'a continuation does NOT consume a failure attempt'
);

-- 11-13. Failure is recorded and is NOT auto-retried.
select is(
  (select count(*)::int from public.claim_candidate_ranking_refresh('a1a1a1a1-1111-1111-1111-111111111111')),
  1,
  'the continuation is claimable again'
);
select is(
  (select status from public.finish_candidate_ranking_refresh('a1a1a1a1-1111-1111-1111-111111111111', 'failed', 'db down')),
  'failed',
  'finish(failed) records the failure'
);
select is(
  (select count(*)::int from public.claim_candidate_ranking_refresh('a1a1a1a1-1111-1111-1111-111111111111')),
  0,
  'a failed refresh is NOT auto-retried by an ordinary claim'
);

-- 14-15. An explicit retry re-arms it.
select is(
  (select status from public.request_candidate_ranking_refresh('a1a1a1a1-1111-1111-1111-111111111111', true)),
  'pending',
  'an explicit retry re-arms a failed refresh'
);
select is(
  (select attempts from public.candidate_ranking_refresh where candidate_id = 'a1a1a1a1-1111-1111-1111-111111111111'),
  0,
  'the retry resets the failure count'
);

-- ---------------------------------------------------------------------------
-- 16-18. The shared posting-index singleton lease and cursor.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.claim_posting_evidence_index(30)),
  1,
  'the shared index claims once'
);
select is(
  (select count(*)::int from public.claim_posting_evidence_index(30)),
  0,
  'the shared index lease excludes a second concurrent indexer'
);
select is(
  (select cursor_offset from public.advance_posting_evidence_index(0, true, 10, 9, null)),
  0,
  'completing a sweep resets the cursor for the next one'
);

reset role;

-- ---------------------------------------------------------------------------
-- 19-20. Cross-candidate isolation.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"b2b2b2b2-2222-2222-2222-222222222222"}';
select is(
  (select count(*)::int from public.candidate_ranking_refresh),
  0,
  'candidate B sees none of candidate A''s refresh rows'
);
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"b2b2b2b2-2222-2222-2222-222222222222"}';
select throws_ok(
  $$insert into public.candidate_ranking_refresh (candidate_id, status)
    values ('b2b2b2b2-2222-2222-2222-222222222222', 'pending')$$,
  '42501',
  null,
  'a candidate cannot start or forge its own refresh'
);
reset role;

select * from finish();
rollback;
