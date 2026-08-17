begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- Fixture setup (as postgres, bypasses RLS — not under test; the
-- application_plans/application_attempts grants/RLS this fixture also
-- touches are covered in their own *_rls.test.sql files).
insert into auth.users (id, email) values
  ('11111111-7003-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-7003-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-7003-1111-1111-111111111111'),
  ('22222222-7003-1111-1111-111111111111');

insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('greenhouse', 'none', 'r2-v1', array['US']);

insert into companies (id, displayed_name, domain)
values ('cccccccc-7003-1111-1111-111111111111', 'Applyco', 'applyco.example');

insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-7003-1111-1111-111111111111', 'greenhouse', 'applyco');

insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
values ('eeeeeeee-7003-1111-1111-111111111111', 'greenhouse', 'dddddddd-7003-1111-1111-111111111111', 'job-evidence-1', 'https://applyco.example/jobs/1', 'Evidence Test Role', 'cccccccc-7003-1111-1111-111111111111');

insert into application_plans (id, candidate_id, vacancy_id, gate_results)
values ('ffffffff-7003-1111-1111-111111111111', '11111111-7003-1111-1111-111111111111', 'eeeeeeee-7003-1111-1111-111111111111', '{}'::jsonb);

insert into application_attempts (id, application_plan_id, status)
values ('99999999-7003-1111-1111-111111111111', 'ffffffff-7003-1111-1111-111111111111', 'succeeded');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.application_evidence'::regclass),
  'RLS is enabled on application_evidence'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'application_evidence' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on application_evidence'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'application_evidence' and grantee = 'anon'$$,
  'anon has no privileges on application_evidence'
);

set local role service_role;

-- 4. service_role can insert evidence
select lives_ok(
  $$insert into application_evidence (id, application_attempt_id, evidence_type, payload)
    values ('88888888-7003-1111-1111-111111111111', '99999999-7003-1111-1111-111111111111', 'submission_receipt', '{"confirmation_id": "abc123"}'::jsonb)$$,
  'service_role can insert into application_evidence'
);
reset role;

-- as Candidate A (owner of the underlying plan, two joins deep)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-7003-1111-1111-111111111111';

-- 5. Candidate A can select evidence via the transitive join through their attempt and plan
select results_eq(
  $$select evidence_type from application_evidence where id = '88888888-7003-1111-1111-111111111111'$$,
  $$values ('submission_receipt'::text)$$,
  'Candidate A can select evidence on their own attempt'
);

-- 6. Candidate A cannot insert — no grant exists for authenticated
select throws_ok(
  $$insert into application_evidence (application_attempt_id, evidence_type, payload)
    values ('99999999-7003-1111-1111-111111111111', 'submission_receipt', '{}'::jsonb)$$,
  '42501',
  null,
  'Candidate A cannot INSERT into application_evidence'
);

-- 7. Candidate A cannot update the evidence — no grant exists
select throws_ok(
  $$update application_evidence set evidence_type = 'edited' where id = '88888888-7003-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot UPDATE evidence on their own attempt'
);

-- 8. Candidate A cannot delete the evidence — no grant exists
select throws_ok(
  $$delete from application_evidence where id = '88888888-7003-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot DELETE evidence on their own attempt'
);
reset role;

-- as Candidate B (not the owner of the underlying plan)
set local role authenticated;
set local request.jwt.claim.sub = '22222222-7003-1111-1111-111111111111';

-- 9. Candidate B cannot see Candidate A's evidence
select is_empty(
  $$select id from application_evidence where id = '88888888-7003-1111-1111-111111111111'$$,
  'Candidate B cannot see evidence on Candidate A''s attempt'
);
reset role;

-- 10. anon cannot select application_evidence
set local role anon;
select throws_ok(
  $$select id from application_evidence$$,
  '42501',
  null,
  'anon cannot SELECT application_evidence — no privilege granted'
);
reset role;

select * from finish();
rollback;
