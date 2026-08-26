begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-7777-1111-1111-111111111111', 'reviewer-a@test.local'),
  ('22222222-7777-1111-1111-111111111111', 'reviewer-b@test.local');

insert into user_roles (user_id, role) values
  ('11111111-7777-1111-1111-111111111111', 'moderator'),
  ('22222222-7777-1111-1111-111111111111', 'moderator');

insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('greenhouse', 'none', 'r2-v1', array['US']);

insert into companies (id, displayed_name, domain)
values ('cccccccc-7777-1111-1111-111111111111', 'Appealco', 'appealco.example');

insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-7777-1111-1111-111111111111', 'greenhouse', 'appealco');

insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
values ('eeeeeeee-7777-1111-1111-111111111111', 'greenhouse', 'dddddddd-7777-1111-1111-111111111111', 'job-appeal-1', 'https://appealco.example/jobs/1', 'Appeal Test Role', 'cccccccc-7777-1111-1111-111111111111');

insert into moderation_cases (id, vacancy_id, source_type, severity, evidence_snapshot)
values ('99999999-7777-1111-1111-111111111111', 'eeeeeeee-7777-1111-1111-111111111111', 'rule', 'high', '{}'::jsonb);

-- The original decision, made by Reviewer A.
insert into moderation_decisions (id, moderation_case_id, reviewer_id, decision, rationale, policy_version)
values ('88888888-7777-1111-1111-111111111111', '99999999-7777-1111-1111-111111111111', '11111111-7777-1111-1111-111111111111', 'blocked', 'Confirmed scam pattern.', 'r3-moderation-v1');

-- =========================================================================
-- Section A: vacancy_appeals RLS (R5.4c: employer/filer SELECT-own, added
-- once the employer-claim system existed — see this table's own migration
-- comment and 20260826040000_vacancy_appeals_employer_access.sql)
-- =========================================================================

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancy_appeals'::regclass),
  'RLS is enabled on vacancy_appeals'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'vacancy_appeals' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on vacancy_appeals'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_appeals' and grantee = 'anon'$$,
  'anon has no privileges on vacancy_appeals'
);

set local role service_role;

-- 4. service_role can insert an appeal against that decision, filed by Reviewer A
select lives_ok(
  $$insert into vacancy_appeals (id, moderation_decision_id, filer_id, rationale)
    values ('77777777-7777-1111-1111-111111111111', '88888888-7777-1111-1111-111111111111', '11111111-7777-1111-1111-111111111111', 'This vacancy is legitimate; the domain check was a false positive.')$$,
  'service_role can insert into vacancy_appeals'
);
reset role;

-- 5. the filer can select their own appeal
set local role authenticated;
set local request.jwt.claim.sub = '11111111-7777-1111-1111-111111111111';
select results_eq(
  $$select filer_id from vacancy_appeals where id = '77777777-7777-1111-1111-111111111111'$$,
  $$values ('11111111-7777-1111-1111-111111111111'::uuid)$$,
  'the filer can select their own appeal'
);
reset role;

-- 6. a non-filer cannot see another user's appeal
set local role authenticated;
set local request.jwt.claim.sub = '22222222-7777-1111-1111-111111111111';
select is_empty(
  $$select id from vacancy_appeals where id = '77777777-7777-1111-1111-111111111111'$$,
  'a non-filer cannot see another user''s appeal'
);
reset role;

-- 7. anon cannot select vacancy_appeals
set local role anon;
select throws_ok(
  $$select rationale from vacancy_appeals$$,
  '42501',
  null,
  'anon cannot SELECT vacancy_appeals — no privilege granted'
);
reset role;

-- =========================================================================
-- Section B: reviewer separation (PRD §13.2 step 31, §13.4)
-- =========================================================================

set local role service_role;

-- 8. a different reviewer CAN decide the appeal
select lives_ok(
  $$insert into moderation_decisions (moderation_case_id, reviewer_id, decision, rationale, policy_version, appeal_id)
    values ('99999999-7777-1111-1111-111111111111', '22222222-7777-1111-1111-111111111111', 'cleared', 'Reviewed the appeal evidence; domain check was indeed a false positive.', 'r3-moderation-v1', '77777777-7777-1111-1111-111111111111')$$,
  'a different reviewer can decide the appeal of another moderator''s original decision'
);

-- 9. the SAME reviewer who made the original decision CANNOT decide its own appeal
select throws_ok(
  $$insert into moderation_decisions (moderation_case_id, reviewer_id, decision, rationale, policy_version, appeal_id)
    values ('99999999-7777-1111-1111-111111111111', '11111111-7777-1111-1111-111111111111', 'cleared', 'x', 'r3-moderation-v1', '77777777-7777-1111-1111-111111111111')$$,
  'P0001',
  null,
  'the same reviewer cannot decide the appeal of their own original decision — reviewer separation enforced'
);

-- 10. an ordinary decision with no appeal_id is unaffected by the trigger
select lives_ok(
  $$insert into moderation_decisions (moderation_case_id, reviewer_id, decision, rationale, policy_version)
    values ('99999999-7777-1111-1111-111111111111', '11111111-7777-1111-1111-111111111111', 'flagged', 'A separate, non-appeal decision.', 'r3-moderation-v1')$$,
  'an ordinary (non-appeal) decision is unaffected by the reviewer-separation trigger'
);
reset role;

-- =========================================================================
-- Section C: moderation_cases.appeal_id link (R5.4c)
-- =========================================================================

set local role service_role;

-- 11. an employer_appeal case can be created linked back to the appeal
select lives_ok(
  $$insert into moderation_cases (id, vacancy_id, source_type, severity, evidence_snapshot, appeal_id)
    values ('66666666-7777-1111-1111-111111111111', 'eeeeeeee-7777-1111-1111-111111111111', 'employer_appeal', 'high', '{"rationale": "false positive"}'::jsonb, '77777777-7777-1111-1111-111111111111')$$,
  'service_role can insert a moderation_cases row linked to its originating appeal'
);

-- 12. the link resolves back to the correct appeal
select results_eq(
  $$select appeal_id from moderation_cases where id = '66666666-7777-1111-1111-111111111111'$$,
  $$values ('77777777-7777-1111-1111-111111111111'::uuid)$$,
  'moderation_cases.appeal_id correctly links back to the vacancy_appeals row'
);
reset role;

select * from finish();
rollback;
