begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Fixture setup (as postgres, bypasses RLS — not under test; the
-- application_plans grants/RLS this fixture also touches are covered in
-- application_plans_rls.test.sql).
insert into auth.users (id, email) values
  ('11111111-7002-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-7002-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-7002-1111-1111-111111111111'),
  ('22222222-7002-1111-1111-111111111111');

insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('greenhouse', 'none', 'r2-v1', array['US']);

insert into companies (id, displayed_name, domain)
values ('cccccccc-7002-1111-1111-111111111111', 'Applyco', 'applyco.example');

insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-7002-1111-1111-111111111111', 'greenhouse', 'applyco');

insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
values ('eeeeeeee-7002-1111-1111-111111111111', 'greenhouse', 'dddddddd-7002-1111-1111-111111111111', 'job-attempt-1', 'https://applyco.example/jobs/1', 'Attempt Test Role', 'cccccccc-7002-1111-1111-111111111111');

insert into application_plans (id, candidate_id, vacancy_id, gate_results)
values ('ffffffff-7002-1111-1111-111111111111', '11111111-7002-1111-1111-111111111111', 'eeeeeeee-7002-1111-1111-111111111111', '{}'::jsonb);

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.application_attempts'::regclass),
  'RLS is enabled on application_attempts'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'application_attempts' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on application_attempts'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'application_attempts' and grantee = 'anon'$$,
  'anon has no privileges on application_attempts'
);

set local role service_role;

-- 4. service_role can insert an attempt
select lives_ok(
  $$insert into application_attempts (id, application_plan_id, status)
    values ('99999999-7002-1111-1111-111111111111', 'ffffffff-7002-1111-1111-111111111111', 'leased')$$,
  'service_role can insert into application_attempts'
);

-- 5. an invalid status value is rejected by the check constraint
select throws_ok(
  $$insert into application_attempts (application_plan_id, status)
    values ('ffffffff-7002-1111-1111-111111111111', 'not_a_real_status')$$,
  '23514',
  null,
  'an invalid application_attempts.status value is rejected by the check constraint'
);
reset role;

-- as Candidate A (owner of the underlying plan)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-7002-1111-1111-111111111111';

-- 6. Candidate A can select the attempt via the transitive join to their plan
select results_eq(
  $$select status from application_attempts where id = '99999999-7002-1111-1111-111111111111'$$,
  $$values ('leased'::text)$$,
  'Candidate A can select an attempt on their own plan'
);

-- 7. Candidate A cannot insert — no grant exists for authenticated
select throws_ok(
  $$insert into application_attempts (application_plan_id, status)
    values ('ffffffff-7002-1111-1111-111111111111', 'pending')$$,
  '42501',
  null,
  'Candidate A cannot INSERT into application_attempts'
);

-- 8. Candidate A cannot update the attempt — no grant exists
select throws_ok(
  $$update application_attempts set status = 'succeeded' where id = '99999999-7002-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot UPDATE an attempt on their own plan'
);

-- 9. Candidate A cannot delete the attempt — no grant exists
select throws_ok(
  $$delete from application_attempts where id = '99999999-7002-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot DELETE an attempt on their own plan'
);
reset role;

-- as Candidate B (not the owner of the underlying plan)
set local role authenticated;
set local request.jwt.claim.sub = '22222222-7002-1111-1111-111111111111';

-- 10. Candidate B cannot see Candidate A's attempt
select is_empty(
  $$select id from application_attempts where id = '99999999-7002-1111-1111-111111111111'$$,
  'Candidate B cannot see an attempt on Candidate A''s plan'
);
reset role;

-- 11. anon cannot select application_attempts
set local role anon;
select throws_ok(
  $$select id from application_attempts$$,
  '42501',
  null,
  'anon cannot SELECT application_attempts — no privilege granted'
);
reset role;

select * from finish();
rollback;
