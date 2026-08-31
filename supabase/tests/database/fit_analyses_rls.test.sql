begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Fixture (as postgres).
insert into auth.users (id, email) values
  ('aaaaaaaa-9211-1111-1111-111111111111', 'fit-a@test.local'),
  ('bbbbbbbb-9211-1111-1111-111111111111', 'fit-b@test.local');
insert into candidate_profiles (id) values
  ('aaaaaaaa-9211-1111-1111-111111111111'),
  ('bbbbbbbb-9211-1111-1111-111111111111');

insert into source_policies (source_code, authentication_method, policy_version)
values ('greenhouse', 'none', 'r2-v1');
insert into vacancy_sources (id, source_code, target_key)
values ('cccccccc-9211-1111-1111-111111111111', 'greenhouse', 'acme');
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title)
values (
  'dddddddd-9211-1111-1111-111111111111',
  'greenhouse', 'cccccccc-9211-1111-1111-111111111111', 'gh-1',
  'https://boards.greenhouse.io/acme/jobs/1', 'Senior Platform Engineer'
);

set local role service_role;
insert into fit_analyses (candidate_id, vacancy_id, jd_text_available, practical_eligibility_score, model_version, prompt_version)
values
  ('aaaaaaaa-9211-1111-1111-111111111111', 'dddddddd-9211-1111-1111-111111111111', false, 100, 'openai/gpt-4o-mini', 'fit-analysis-v1'),
  ('bbbbbbbb-9211-1111-1111-111111111111', 'dddddddd-9211-1111-1111-111111111111', false, 0,   'openai/gpt-4o-mini', 'fit-analysis-v1');
reset role;

-- 1. RLS enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.fit_analyses'::regclass),
  'RLS is enabled on fit_analyses'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'fit_analyses' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on fit_analyses'
);

-- 3. anon has no privileges
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'fit_analyses' and grantee = 'anon'$$,
  'anon has no privileges on fit_analyses'
);

-- 4. candidate A sees only their own row
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-9211-1111-1111-111111111111"}';
select is(
  (select count(*)::int from fit_analyses),
  1,
  'candidate A sees exactly one fit_analyses row'
);
select is(
  (select candidate_id::text from fit_analyses),
  'aaaaaaaa-9211-1111-1111-111111111111',
  'the row candidate A sees is their own'
);

-- 5. candidate B's row is invisible to A
select is_empty(
  $$select id from fit_analyses where candidate_id = 'bbbbbbbb-9211-1111-1111-111111111111'$$,
  'candidate A cannot see candidate B''s fit_analyses row'
);

-- 6. authenticated cannot INSERT
select throws_ok(
  $$insert into fit_analyses (candidate_id, vacancy_id, jd_text_available, model_version, prompt_version)
    values ('aaaaaaaa-9211-1111-1111-111111111111', 'dddddddd-9211-1111-1111-111111111111', false, 'm', 'p')$$,
  '42501',
  null,
  'authenticated cannot INSERT into fit_analyses'
);

-- 7. authenticated cannot UPDATE
select throws_ok(
  $$update fit_analyses set technical_fit_score = 100 where candidate_id = 'aaaaaaaa-9211-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated cannot UPDATE fit_analyses'
);
reset role;

-- 8. candidate B sees only their own row
set local role authenticated;
set local request.jwt.claims to '{"sub":"bbbbbbbb-9211-1111-1111-111111111111"}';
select is(
  (select count(*)::int from fit_analyses),
  1,
  'candidate B sees exactly one fit_analyses row (their own)'
);
reset role;

-- 9. one analysis per (candidate, vacancy)
set local role service_role;
select throws_ok(
  $$insert into fit_analyses (candidate_id, vacancy_id, jd_text_available, model_version, prompt_version)
    values ('aaaaaaaa-9211-1111-1111-111111111111', 'dddddddd-9211-1111-1111-111111111111', false, 'm', 'p')$$,
  '23505',
  null,
  'a second fit_analyses row for the same (candidate, vacancy) is rejected'
);

-- 10. score range constraint
select throws_ok(
  $$update fit_analyses set technical_fit_score = 150
      where candidate_id = 'aaaaaaaa-9211-1111-1111-111111111111'$$,
  '23514',
  null,
  'technical_fit_score above 100 violates the check constraint'
);
reset role;

select * from finish();
rollback;
