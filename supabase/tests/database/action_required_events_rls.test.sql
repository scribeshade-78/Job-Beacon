begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Fixture setup (as postgres, bypasses RLS — not under test; the
-- application_plans/application_attempts grants/RLS this fixture also
-- touches are covered in their own *_rls.test.sql files).
insert into auth.users (id, email) values
  ('11111111-7004-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-7004-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-7004-1111-1111-111111111111'),
  ('22222222-7004-1111-1111-111111111111');

insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('greenhouse', 'none', 'r2-v1', array['US']);

insert into companies (id, displayed_name, domain)
values ('cccccccc-7004-1111-1111-111111111111', 'Applyco', 'applyco.example');

insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-7004-1111-1111-111111111111', 'greenhouse', 'applyco');

insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
values ('eeeeeeee-7004-1111-1111-111111111111', 'greenhouse', 'dddddddd-7004-1111-1111-111111111111', 'job-action-1', 'https://applyco.example/jobs/1', 'Action Required Test Role', 'cccccccc-7004-1111-1111-111111111111');

insert into application_plans (id, candidate_id, vacancy_id, gate_results)
values ('ffffffff-7004-1111-1111-111111111111', '11111111-7004-1111-1111-111111111111', 'eeeeeeee-7004-1111-1111-111111111111', '{}'::jsonb);

insert into application_attempts (id, application_plan_id, status)
values ('99999999-7004-1111-1111-111111111111', 'ffffffff-7004-1111-1111-111111111111', 'action_required');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.action_required_events'::regclass),
  'RLS is enabled on action_required_events'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'action_required_events' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on action_required_events'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'action_required_events' and grantee = 'anon'$$,
  'anon has no privileges on action_required_events'
);

set local role service_role;

-- 4. service_role can insert an action-required event
select lives_ok(
  $$insert into action_required_events (id, application_attempt_id, exception_type, payload)
    values ('77777777-7004-1111-1111-111111111111', '99999999-7004-1111-1111-111111111111', 'missing_verified_fact', '{"fact": "work_authorization"}'::jsonb)$$,
  'service_role can insert into action_required_events'
);

-- 5. an invalid exception_type value is rejected by the check constraint
select throws_ok(
  $$insert into action_required_events (application_attempt_id, exception_type, payload)
    values ('99999999-7004-1111-1111-111111111111', 'not_a_real_exception_type', '{}'::jsonb)$$,
  '23514',
  null,
  'an invalid action_required_events.exception_type value is rejected by the check constraint'
);
reset role;

-- as Candidate A (owner of the underlying plan, two joins deep)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-7004-1111-1111-111111111111';

-- 6. Candidate A can select the event via the transitive join through their attempt and plan
select results_eq(
  $$select exception_type from action_required_events where id = '77777777-7004-1111-1111-111111111111'$$,
  $$values ('missing_verified_fact'::text)$$,
  'Candidate A can select an action-required event on their own attempt'
);

-- 7. Candidate A cannot insert — no grant exists for authenticated
select throws_ok(
  $$insert into action_required_events (application_attempt_id, exception_type, payload)
    values ('99999999-7004-1111-1111-111111111111', 'captcha', '{}'::jsonb)$$,
  '42501',
  null,
  'Candidate A cannot INSERT into action_required_events'
);

-- 8. Candidate A cannot update the event — no grant exists
select throws_ok(
  $$update action_required_events set resolved_at = now() where id = '77777777-7004-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot UPDATE an action-required event on their own attempt'
);

-- 9. Candidate A cannot delete the event — no grant exists
select throws_ok(
  $$delete from action_required_events where id = '77777777-7004-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot DELETE an action-required event on their own attempt'
);
reset role;

-- as Candidate B (not the owner of the underlying plan)
set local role authenticated;
set local request.jwt.claim.sub = '22222222-7004-1111-1111-111111111111';

-- 10. Candidate B cannot see Candidate A's event
select is_empty(
  $$select id from action_required_events where id = '77777777-7004-1111-1111-111111111111'$$,
  'Candidate B cannot see an action-required event on Candidate A''s attempt'
);
reset role;

-- 11. anon cannot select action_required_events
set local role anon;
select throws_ok(
  $$select id from action_required_events$$,
  '42501',
  null,
  'anon cannot SELECT action_required_events — no privilege granted'
);
reset role;

select * from finish();
rollback;
