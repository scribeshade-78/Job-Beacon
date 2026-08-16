begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

-- Fixture setup (as postgres, bypasses RLS — not under test; vacancies/
-- source_policies/companies/vacancy_sources RLS is already covered in
-- vacancy_discovery_rls.test.sql).
insert into auth.users (id, email) values
  ('11111111-4444-1111-1111-111111111111', 'moderator-a@test.local');

insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('greenhouse', 'none', 'r2-v1', array['US']);

insert into companies (id, displayed_name, domain)
values ('cccccccc-4444-1111-1111-111111111111', 'Modco', 'modco.example');

insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-4444-1111-1111-111111111111', 'greenhouse', 'modco');

insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
values ('eeeeeeee-4444-1111-1111-111111111111', 'greenhouse', 'dddddddd-4444-1111-1111-111111111111', 'job-mod-1', 'https://modco.example/jobs/1', 'Moderation Test Role', 'cccccccc-4444-1111-1111-111111111111');

-- =========================================================================
-- Section A: moderation_cases
-- =========================================================================

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.moderation_cases'::regclass),
  'RLS is enabled on moderation_cases'
);

-- 2. authenticated has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'moderation_cases' and grantee = 'authenticated'$$,
  'authenticated has no privileges on moderation_cases'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'moderation_cases' and grantee = 'anon'$$,
  'anon has no privileges on moderation_cases'
);

set local role service_role;

-- 4. service_role can insert a case
select lives_ok(
  $$insert into moderation_cases (id, vacancy_id, source_type, severity, evidence_snapshot)
    values ('ffffffff-4444-1111-1111-111111111111', 'eeeeeeee-4444-1111-1111-111111111111', 'rule', 'high', '{"trust_score": 42}'::jsonb)$$,
  'service_role can insert into moderation_cases'
);

-- 5. an invalid source_type value is rejected by the check constraint
select throws_ok(
  $$insert into moderation_cases (vacancy_id, source_type, severity, evidence_snapshot)
    values ('eeeeeeee-4444-1111-1111-111111111111', 'not_a_real_source_type', 'high', '{}'::jsonb)$$,
  '23514',
  null,
  'an invalid moderation_cases.source_type value is rejected by the check constraint'
);

-- 6. an invalid severity value is rejected by the check constraint
select throws_ok(
  $$insert into moderation_cases (vacancy_id, source_type, severity, evidence_snapshot)
    values ('eeeeeeee-4444-1111-1111-111111111111', 'rule', 'not_a_real_severity', '{}'::jsonb)$$,
  '23514',
  null,
  'an invalid moderation_cases.severity value is rejected by the check constraint'
);

-- 7. service_role can link a related/duplicate case
select lives_ok(
  $$insert into moderation_cases (vacancy_id, source_type, severity, evidence_snapshot, related_case_id)
    values ('eeeeeeee-4444-1111-1111-111111111111', 'community_report', 'medium', '{}'::jsonb, 'ffffffff-4444-1111-1111-111111111111')$$,
  'service_role can insert a case linked to a related/duplicate case'
);
reset role;

-- 8. authenticated cannot select moderation_cases
set local role authenticated;
set local request.jwt.claim.sub = '11111111-4444-1111-1111-111111111111';
select throws_ok(
  $$select severity from moderation_cases$$,
  '42501',
  null,
  'authenticated cannot SELECT moderation_cases — no privilege granted'
);
reset role;

-- 9. anon cannot select moderation_cases
set local role anon;
select throws_ok(
  $$select severity from moderation_cases$$,
  '42501',
  null,
  'anon cannot SELECT moderation_cases — no privilege granted'
);
reset role;

-- =========================================================================
-- Section B: moderation_decisions
-- =========================================================================

-- 10. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.moderation_decisions'::regclass),
  'RLS is enabled on moderation_decisions'
);

-- 11. authenticated has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'moderation_decisions' and grantee = 'authenticated'$$,
  'authenticated has no privileges on moderation_decisions'
);

-- 12. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'moderation_decisions' and grantee = 'anon'$$,
  'anon has no privileges on moderation_decisions'
);

set local role service_role;

-- 13. service_role can insert a decision
select lives_ok(
  $$insert into moderation_decisions (moderation_case_id, reviewer_id, decision, rationale, policy_version)
    values ('ffffffff-4444-1111-1111-111111111111', '11111111-4444-1111-1111-111111111111', 'blocked', 'Confirmed payment-request scam pattern.', 'r3-moderation-v1')$$,
  'service_role can insert into moderation_decisions'
);

-- 14. an invalid decision value is rejected by the check constraint
select throws_ok(
  $$insert into moderation_decisions (moderation_case_id, reviewer_id, decision, rationale, policy_version)
    values ('ffffffff-4444-1111-1111-111111111111', '11111111-4444-1111-1111-111111111111', 'not_a_real_decision', 'x', 'r3-moderation-v1')$$,
  '23514',
  null,
  'an invalid moderation_decisions.decision value is rejected by the check constraint'
);
reset role;

-- 15. authenticated cannot select moderation_decisions
set local role authenticated;
set local request.jwt.claim.sub = '11111111-4444-1111-1111-111111111111';
select throws_ok(
  $$select decision from moderation_decisions$$,
  '42501',
  null,
  'authenticated cannot SELECT moderation_decisions — no privilege granted'
);
reset role;

-- 16. anon cannot select moderation_decisions
set local role anon;
select throws_ok(
  $$select decision from moderation_decisions$$,
  '42501',
  null,
  'anon cannot SELECT moderation_decisions — no privilege granted'
);
reset role;

select * from finish();
rollback;
