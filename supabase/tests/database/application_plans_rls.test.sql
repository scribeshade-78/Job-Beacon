begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-7001-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-7001-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-7001-1111-1111-111111111111'),
  ('22222222-7001-1111-1111-111111111111');

insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('greenhouse', 'none', 'r2-v1', array['US']);

insert into companies (id, displayed_name, domain)
values ('cccccccc-7001-1111-1111-111111111111', 'Applyco', 'applyco.example');

insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-7001-1111-1111-111111111111', 'greenhouse', 'applyco');

insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
values ('eeeeeeee-7001-1111-1111-111111111111', 'greenhouse', 'dddddddd-7001-1111-1111-111111111111', 'job-plan-1', 'https://applyco.example/jobs/1', 'Plan Test Role', 'cccccccc-7001-1111-1111-111111111111');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.application_plans'::regclass),
  'RLS is enabled on application_plans'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'application_plans' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on application_plans'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'application_plans' and grantee = 'anon'$$,
  'anon has no privileges on application_plans'
);

set local role service_role;

-- 4. service_role can insert a plan
select lives_ok(
  $$insert into application_plans (id, candidate_id, vacancy_id, gate_results)
    values ('ffffffff-7001-1111-1111-111111111111', '11111111-7001-1111-1111-111111111111', 'eeeeeeee-7001-1111-1111-111111111111', '{"source_policy": "fail", "vacancy_trust": "fail"}'::jsonb)$$,
  'service_role can insert into application_plans'
);

-- 5. unique (candidate_id, vacancy_id) rejects a second plan for the same pair
select throws_ok(
  $$insert into application_plans (candidate_id, vacancy_id, gate_results)
    values ('11111111-7001-1111-1111-111111111111', 'eeeeeeee-7001-1111-1111-111111111111', '{}'::jsonb)$$,
  '23505',
  null,
  'a duplicate (candidate_id, vacancy_id) plan is rejected as the idempotency anchor requires'
);
reset role;

-- as Candidate A
set local role authenticated;
set local request.jwt.claim.sub = '11111111-7001-1111-1111-111111111111';

-- 6. Candidate A can select their own plan
select results_eq(
  $$select vacancy_id from application_plans where id = 'ffffffff-7001-1111-1111-111111111111'$$,
  $$values ('eeeeeeee-7001-1111-1111-111111111111'::uuid)$$,
  'Candidate A can select their own plan'
);

-- 7. Candidate A cannot insert — no grant exists for authenticated
select throws_ok(
  $$insert into application_plans (candidate_id, vacancy_id, gate_results)
    values ('11111111-7001-1111-1111-111111111111', 'eeeeeeee-7001-1111-1111-111111111111', '{}'::jsonb)$$,
  '42501',
  null,
  'Candidate A cannot INSERT into application_plans'
);

-- 8. Candidate A cannot update their own plan — no grant exists
select throws_ok(
  $$update application_plans set gate_results = '{}'::jsonb where id = 'ffffffff-7001-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot UPDATE their own plan'
);

-- 9. Candidate A cannot delete their own plan — no grant exists
select throws_ok(
  $$delete from application_plans where id = 'ffffffff-7001-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot DELETE their own plan'
);
reset role;

-- as Candidate B
set local role authenticated;
set local request.jwt.claim.sub = '22222222-7001-1111-1111-111111111111';

-- 10. Candidate B cannot see Candidate A's plan
select is_empty(
  $$select id from application_plans where id = 'ffffffff-7001-1111-1111-111111111111'$$,
  'Candidate B cannot see Candidate A''s plan'
);
reset role;

-- 11. anon cannot select application_plans
set local role anon;
select throws_ok(
  $$select id from application_plans$$,
  '42501',
  null,
  'anon cannot SELECT application_plans — no privilege granted'
);
reset role;

select * from finish();
rollback;
