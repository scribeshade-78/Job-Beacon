-- UNEXECUTED — there is no isolated Postgres/Supabase instance available in this
-- session. This file documents the fixtures that MUST be run against one before
-- any claim of trigger, transaction, RLS or concurrency correctness is made.
-- Nothing here has been executed, and the mocked TypeScript tests in
-- server/opportunities/materializeRoleMatches.test.ts do NOT establish any of it.
--
-- Run with: supabase test db   (or psql against a disposable local database)
-- Requires the additive migration 20261001320000_role_match_freshness.sql.
--
-- What only this file can prove:
--   * the trigger's OLD/NEW comparisons (insert/delete/enter/leave/title change,
--     and NO bump for a no-op or a non-relevant column);
--   * that the version bump is transactional with the mutation;
--   * that publish_role_match_coverage validates and advances in one transaction,
--     so a scan spanning a change cannot publish;
--   * grants: candidates may execute the read function and nothing else.

begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

-- ---------------------------------------------------------------------------
-- Fixtures.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('a1a1a1a1-1111-1111-1111-111111111111', 'role-a@test.local'),
  ('b2b2b2b2-2222-2222-2222-222222222222', 'role-b@test.local');

insert into candidate_profiles (id) values
  ('a1a1a1a1-1111-1111-1111-111111111111'),
  ('b2b2b2b2-2222-2222-2222-222222222222');

insert into source_policies (source_code, authentication_method, policy_version)
values ('pgtap_fixture', 'none', 'r2-v1');

insert into vacancy_sources (id, source_code, target_key)
values ('c3c3c3c3-3333-3333-3333-333333333333', 'pgtap_fixture', 'pgtap');

-- b1 / b2 are browseable (active + VERIFIED); n1 is unknown-trust and n2 is
-- expired, so neither is part of the corpus.
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, status, trust_status) values
  ('d1d1d1d1-1111-1111-1111-111111111111', 'pgtap_fixture', 'c3c3c3c3-3333-3333-3333-333333333333', 'gh-1', 'https://pgtap.test/jobs/1', 'Data Engineer', 'active', 'VERIFIED'),
  ('d2d2d2d2-2222-2222-2222-222222222222', 'pgtap_fixture', 'c3c3c3c3-3333-3333-3333-333333333333', 'gh-2', 'https://pgtap.test/jobs/2', 'Teacher',        'active', 'VERIFIED'),
  ('d3d3d3d3-3333-3333-3333-333333333333', 'pgtap_fixture', 'c3c3c3c3-3333-3333-3333-333333333333', 'gh-3', 'https://pgtap.test/jobs/3', 'Data Engineer', 'active', null),
  ('d4d4d4d4-4444-4444-4444-444444444444', 'pgtap_fixture', 'c3c3c3c3-3333-3333-3333-333333333333', 'gh-4', 'https://pgtap.test/jobs/4', 'Data Engineer', 'expired', 'VERIFIED');

create temporary table corpus_probe (version bigint);
insert into corpus_probe select version from public.vacancy_corpus_version;

-- corpus_probe is read again below while the session is switched to service_role
-- (publish_role_match_coverage is worker-only), so it needs the grant.
grant select on corpus_probe to service_role;

-- ---------------------------------------------------------------------------
-- 1-5. The version row and its access model.
-- ---------------------------------------------------------------------------
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancy_corpus_version'::regclass),
  'RLS is enabled on vacancy_corpus_version'
);

select is(
  (select count(*)::int from public.vacancy_corpus_version),
  1,
  'the corpus version is a singleton row'
);

select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_corpus_version' and grantee = 'authenticated'$$,
  'authenticated has no direct table privilege on vacancy_corpus_version'
);

select ok(
  has_function_privilege('authenticated', 'public.current_role_match_corpus_version()', 'EXECUTE'),
  'authenticated may execute the read-only corpus-version function'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.publish_role_match_coverage(uuid,uuid,bigint,integer,integer)',
    'EXECUTE'
  ),
  'authenticated may NOT execute the publish function'
);

-- ---------------------------------------------------------------------------
-- 6-15. The trigger: what counts as a relevant mutation.
-- ---------------------------------------------------------------------------
-- 6. Inserting a NON-browseable vacancy is not a corpus change.
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, status, trust_status)
values ('d5d5d5d5-5555-5555-5555-555555555555', 'pgtap_fixture', 'c3c3c3c3-3333-3333-3333-333333333333', 'gh-5', 'https://pgtap.test/jobs/5', 'Data Engineer', 'active', null);
select is(
  (select version from public.vacancy_corpus_version),
  (select version from corpus_probe),
  'inserting a non-browseable vacancy does not move the corpus version'
);

-- 7. A no-op update does not move it.
update public.vacancies set raw_title = raw_title, trust_status = trust_status
  where id = 'd1d1d1d1-1111-1111-1111-111111111111';
select is(
  (select version from public.vacancy_corpus_version),
  (select version from corpus_probe),
  'a no-op update on a browseable vacancy does not move the corpus version'
);

-- 8. A non-relevant column change does not move it.
update public.vacancies set salary_max = 1000
  where id = 'd1d1d1d1-1111-1111-1111-111111111111';
select is(
  (select version from public.vacancy_corpus_version),
  (select version from corpus_probe),
  'a non-relevant column change does not move the corpus version'
);

-- 9. A title change on a browseable vacancy is relevant.
update public.vacancies set raw_title = 'Senior Data Engineer'
  where id = 'd1d1d1d1-1111-1111-1111-111111111111';
select isnt(
  (select version from public.vacancy_corpus_version),
  (select version from corpus_probe),
  'a raw_title change on a browseable vacancy moves the corpus version'
);
update corpus_probe set version = (select version from public.vacancy_corpus_version);

-- 10. A title change on a NON-browseable vacancy is not relevant.
update public.vacancies set raw_title = 'Registered Nurse'
  where id = 'd3d3d3d3-3333-3333-3333-333333333333';
select is(
  (select version from public.vacancy_corpus_version),
  (select version from corpus_probe),
  'a raw_title change on a non-browseable vacancy does not move the corpus version'
);

-- 11. Leaving the browseable set is relevant.
update public.vacancies set trust_status = 'BLOCKED'
  where id = 'd1d1d1d1-1111-1111-1111-111111111111';
select isnt(
  (select version from public.vacancy_corpus_version),
  (select version from corpus_probe),
  'leaving the browseable set moves the corpus version'
);
update corpus_probe set version = (select version from public.vacancy_corpus_version);

-- 12. Re-entering the browseable set is relevant.
update public.vacancies set trust_status = 'VERIFIED'
  where id = 'd1d1d1d1-1111-1111-1111-111111111111';
select isnt(
  (select version from public.vacancy_corpus_version),
  (select version from corpus_probe),
  're-entering the browseable set moves the corpus version'
);
update corpus_probe set version = (select version from public.vacancy_corpus_version);

-- 13. Deleting a non-browseable vacancy is not relevant.
delete from public.vacancies where id = 'd4d4d4d4-4444-4444-4444-444444444444';
select is(
  (select version from public.vacancy_corpus_version),
  (select version from corpus_probe),
  'deleting a non-browseable vacancy does not move the corpus version'
);

-- 14. Inserting a browseable vacancy is relevant.
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, status, trust_status)
values ('d6d6d6d6-6666-6666-6666-666666666666', 'pgtap_fixture', 'c3c3c3c3-3333-3333-3333-333333333333', 'gh-6', 'https://pgtap.test/jobs/6', 'Data Engineer', 'active', 'UNDER_REVIEW');
select isnt(
  (select version from public.vacancy_corpus_version),
  (select version from corpus_probe),
  'inserting a browseable vacancy moves the corpus version'
);
update corpus_probe set version = (select version from public.vacancy_corpus_version);

-- 15. Deleting a browseable vacancy is relevant.
delete from public.vacancies where id = 'd6d6d6d6-6666-6666-6666-666666666666';
select isnt(
  (select version from public.vacancy_corpus_version),
  (select version from corpus_probe),
  'deleting a browseable vacancy moves the corpus version'
);
update corpus_probe set version = (select version from public.vacancy_corpus_version);

-- ---------------------------------------------------------------------------
-- 16-19. A scan that spans a change cannot publish, and is not relabelled.
-- ---------------------------------------------------------------------------
-- Arrange a running scan that started at the version BEFORE the next mutation.
insert into candidate_role_match_coverage
  (candidate_id, running_generation, running_corpus_version, status, corpus_complete, role_input_fingerprint, matcher_version)
values
  ('a1a1a1a1-1111-1111-1111-111111111111', 'e1e1e1e1-1111-1111-1111-111111111111',
   (select version from public.vacancy_corpus_version), 'running', false, 'fp-a', 'role-taxonomy-v1');

-- A relevant mutation commits while that scan is "running".
update public.vacancies set raw_title = 'Staff Data Engineer'
  where id = 'd2d2d2d2-2222-2222-2222-222222222222';

set local role service_role;

-- 16. Publishing against the version the scan started at fails.
select is(
  public.publish_role_match_coverage(
    'a1a1a1a1-1111-1111-1111-111111111111',
    'e1e1e1e1-1111-1111-1111-111111111111',
    (select version from corpus_probe),
    2,
    1
  ),
  false,
  'a scan that spans a corpus change cannot publish (version mismatch)'
);

-- 17. Nothing became published.
select is(
  (select published_generation from public.candidate_role_match_coverage
     where candidate_id = 'a1a1a1a1-1111-1111-1111-111111111111'),
  null,
  'a failed publish leaves published_generation NULL'
);

-- 18. The running scan is not relabelled with the newer version.
select is(
  (select running_corpus_version from public.candidate_role_match_coverage
     where candidate_id = 'a1a1a1a1-1111-1111-1111-111111111111'),
  (select version from corpus_probe),
  'the incomplete generation still records the version it started at, not the newer one'
);

-- 19. Publishing at the CURRENT version succeeds and advances the pointer.
select is(
  public.publish_role_match_coverage(
    'a1a1a1a1-1111-1111-1111-111111111111',
    'e1e1e1e1-1111-1111-1111-111111111111',
    (select version from public.vacancy_corpus_version),
    2,
    1
  ),
  true,
  'publishing at the current corpus version succeeds'
);

reset role;

-- ---------------------------------------------------------------------------
-- 20-21. Read-time validity: the published version is compared, never trusted.
-- ---------------------------------------------------------------------------
select is(
  (select published_corpus_version from public.candidate_role_match_coverage
     where candidate_id = 'a1a1a1a1-1111-1111-1111-111111111111'),
  (select version from public.vacancy_corpus_version),
  'the published coverage records the current corpus version'
);

-- A later relevant mutation makes the published version stale.
update public.vacancies set raw_title = 'Lead Data Engineer'
  where id = 'd2d2d2d2-2222-2222-2222-222222222222';
select isnt(
  (select published_corpus_version from public.candidate_role_match_coverage
     where candidate_id = 'a1a1a1a1-1111-1111-1111-111111111111'),
  (select version from public.vacancy_corpus_version),
  'a later mutation makes the published coverage stale (published version <> current)'
);

-- ---------------------------------------------------------------------------
-- 22-24. Legacy input, and candidate isolation.
-- ---------------------------------------------------------------------------
-- A pre-freshness published row has no published_corpus_version: legacy-unknown,
-- never current.
set local role service_role;
insert into candidate_role_match_coverage
  (candidate_id, published_generation, status, corpus_complete, role_input_fingerprint, matcher_version)
values
  ('b2b2b2b2-2222-2222-2222-222222222222', 'e2e2e2e2-2222-2222-2222-222222222222', 'complete', true, 'fp-b', 'role-taxonomy-v1');

-- A legacy match row keeps NULL input_title; a new one records the exact title.
insert into candidate_role_matches (candidate_id, role_name, vacancy_id, generation, matcher_version, input_title)
values
  ('a1a1a1a1-1111-1111-1111-111111111111', 'Data Engineer', 'd1d1d1d1-1111-1111-1111-111111111111',
   'e3e3e3e3-3333-3333-3333-333333333333', 'role-taxonomy-v1', 'Senior Data Engineer'),
  ('a1a1a1a1-1111-1111-1111-111111111111', 'Data Engineer', 'd2d2d2d2-2222-2222-2222-222222222222',
   'e3e3e3e3-3333-3333-3333-333333333333', 'role-taxonomy-v1', null);
reset role;

select is(
  (select published_corpus_version from public.candidate_role_match_coverage
     where candidate_id = 'b2b2b2b2-2222-2222-2222-222222222222'),
  null,
  'a published row with no corpus version is legacy-unknown, never current'
);

select is(
  (select count(*)::int from public.candidate_role_matches
     where generation = 'e3e3e3e3-3333-3333-3333-333333333333' and input_title is null),
  1,
  'a legacy match row without a recorded input stays NULL (unknown), never backfilled'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"a1a1a1a1-1111-1111-1111-111111111111"}';
select is(
  (select count(*)::int from public.candidate_role_match_coverage),
  1,
  'candidate A sees exactly one coverage row (their own)'
);
reset role;

-- ---------------------------------------------------------------------------
-- 25. Candidate B's coverage is invisible to A.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"a1a1a1a1-1111-1111-1111-111111111111"}';
select is_empty(
  $$select candidate_id from public.candidate_role_match_coverage
      where candidate_id = 'b2b2b2b2-2222-2222-2222-222222222222'$$,
  'candidate A cannot see candidate B''s coverage'
);
reset role;

select * from finish();
rollback;
