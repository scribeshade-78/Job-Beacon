begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Fixture (as postgres, bypasses RLS).
insert into auth.users (id, email) values
  ('11111111-9210-1111-1111-111111111111', 'jd-candidate-a@test.local');
insert into candidate_profiles (id) values
  ('11111111-9210-1111-1111-111111111111');

insert into source_policies (source_code, authentication_method, policy_version)
values ('greenhouse', 'none', 'r2-v1');
insert into vacancy_sources (id, source_code, target_key)
values ('22222222-9210-1111-1111-111111111111', 'greenhouse', 'acme');
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title)
values (
  '33333333-9210-1111-1111-111111111111',
  'greenhouse',
  '22222222-9210-1111-1111-111111111111',
  'gh-1',
  'https://boards.greenhouse.io/acme/jobs/1',
  'Senior Platform Engineer'
);
insert into vacancy_versions (id, vacancy_id, raw_payload, content_hash)
values (
  '44444444-9210-1111-1111-111111111111',
  '33333333-9210-1111-1111-111111111111',
  '{"content":"<p>x</p>"}'::jsonb,
  'hash-1'
);
insert into vacancy_jd_snapshots (id, vacancy_id, vacancy_version_id, canonical_url, clean_text, sections, source_code, extractor_version)
values (
  '55555555-9210-1111-1111-111111111111',
  '33333333-9210-1111-1111-111111111111',
  '44444444-9210-1111-1111-111111111111',
  'https://boards.greenhouse.io/acme/jobs/1',
  'Build platforms.',
  '[{"heading":"Duties","body":"Build platforms."}]'::jsonb,
  'greenhouse',
  'jd-extract-v1'
);

-- 1. RLS enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancy_jd_snapshots'::regclass),
  'RLS is enabled on vacancy_jd_snapshots'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'vacancy_jd_snapshots' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on vacancy_jd_snapshots'
);

-- 3. anon has no privileges
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_jd_snapshots' and grantee = 'anon'$$,
  'anon has no privileges on vacancy_jd_snapshots'
);

-- 4. an authenticated user can read JD snapshots (public posting content, no candidate scoping)
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-9210-1111-1111-111111111111"}';
-- scoped to this file's own fixture vacancy: snapshots are public posting
-- content, and the live database already has ~200 of them, so a global count
-- only ever equalled 1 on an empty one
select is(
  (select count(*)::int from vacancy_jd_snapshots
     where vacancy_id = '33333333-9210-1111-1111-111111111111'),
  1,
  'authenticated can SELECT vacancy_jd_snapshots rows'
);

-- 5. authenticated cannot INSERT
select throws_ok(
  $$insert into vacancy_jd_snapshots (vacancy_id, vacancy_version_id, canonical_url, clean_text, sections, source_code, extractor_version)
    values ('33333333-9210-1111-1111-111111111111', '44444444-9210-1111-1111-111111111111', 'u', 't', '[]'::jsonb, 'greenhouse', 'jd-extract-v1')$$,
  '42501',
  null,
  'authenticated cannot INSERT into vacancy_jd_snapshots'
);

-- 6. authenticated cannot UPDATE
select throws_ok(
  $$update vacancy_jd_snapshots set clean_text = 'tampered' where id = '55555555-9210-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated cannot UPDATE vacancy_jd_snapshots'
);

-- 7. authenticated cannot DELETE
select throws_ok(
  $$delete from vacancy_jd_snapshots where id = '55555555-9210-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated cannot DELETE vacancy_jd_snapshots'
);
reset role;

-- 8. service_role can write
set local role service_role;
select lives_ok(
  $$update vacancy_jd_snapshots set clean_text = 'Build resilient platforms.' where id = '55555555-9210-1111-1111-111111111111'$$,
  'service_role can UPDATE vacancy_jd_snapshots'
);
reset role;

-- 9. one snapshot per raw version (unique vacancy_version_id)
set local role service_role;
select throws_ok(
  $$insert into vacancy_jd_snapshots (vacancy_id, vacancy_version_id, canonical_url, clean_text, sections, source_code, extractor_version)
    values ('33333333-9210-1111-1111-111111111111', '44444444-9210-1111-1111-111111111111', 'u', 't2', '[]'::jsonb, 'greenhouse', 'jd-extract-v1')$$,
  '23505',
  null,
  'a second snapshot for the same vacancy_version_id is rejected'
);
reset role;

select * from finish();
rollback;
