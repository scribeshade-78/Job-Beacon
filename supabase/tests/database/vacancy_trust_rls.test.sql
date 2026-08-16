begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- Fixture setup (as postgres, bypasses RLS — not under test; vacancies RLS
-- itself is already covered in vacancy_discovery_rls.test.sql).
insert into auth.users (id, email) values
  ('11111111-3333-1111-1111-111111111111', 'candidate-trust@test.local');

insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('greenhouse', 'none', 'r2-v1', array['US']);

insert into companies (id, displayed_name, domain)
values ('cccccccc-3333-1111-1111-111111111111', 'Trustco', 'trustco.example');

insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-3333-1111-1111-111111111111', 'greenhouse', 'trustco');

insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
values ('eeeeeeee-3333-1111-1111-111111111111', 'greenhouse', 'dddddddd-3333-1111-1111-111111111111', 'job-trust-1', 'https://trustco.example/jobs/1', 'Trust Test Role', 'cccccccc-3333-1111-1111-111111111111');

-- =========================================================================
-- Section A: vacancies.trust_status (denormalized current-status pointer)
-- =========================================================================

-- 1. RLS is still enabled on vacancies after the additive migration
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancies'::regclass),
  'RLS is still enabled on vacancies after adding trust_status'
);

-- 2. trust_status is NULL by default — no scoring logic exists yet in R3.1
set local role authenticated;
set local request.jwt.claim.sub = '11111111-3333-1111-1111-111111111111';
select is(
  (select trust_status from vacancies where id = 'eeeeeeee-3333-1111-1111-111111111111'),
  null,
  'trust_status is NULL by default before any scoring run'
);

-- 3. authenticated candidate cannot UPDATE trust_status — no grant/policy for it
select throws_ok(
  $$update vacancies set trust_status = 'VERIFIED' where id = 'eeeeeeee-3333-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated candidate cannot UPDATE vacancies.trust_status'
);
reset role;

-- 4. service_role can UPDATE trust_status (scoring worker write path)
set local role service_role;
select lives_ok(
  $$update vacancies set trust_status = 'VERIFIED' where id = 'eeeeeeee-3333-1111-1111-111111111111'$$,
  'service_role can UPDATE vacancies.trust_status'
);

-- 5. an invalid trust_status value is rejected by the check constraint
select throws_ok(
  $$update vacancies set trust_status = 'NOT_A_REAL_STATUS' where id = 'eeeeeeee-3333-1111-1111-111111111111'$$,
  '23514',
  null,
  'an invalid trust_status value is rejected by the check constraint'
);
reset role;

-- 6. authenticated candidate reads the updated trust_status via the
-- existing vacancies_select_all policy — no new policy was needed
set local role authenticated;
set local request.jwt.claim.sub = '11111111-3333-1111-1111-111111111111';
select results_eq(
  $$select trust_status from vacancies where id = 'eeeeeeee-3333-1111-1111-111111111111'$$,
  $$values ('VERIFIED'::text)$$,
  'authenticated candidate can read the updated trust_status'
);
reset role;

-- =========================================================================
-- Section B: vacancy_trust_scores (authoritative, append-only scored
-- history — service_role only)
-- =========================================================================

-- 7. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancy_trust_scores'::regclass),
  'RLS is enabled on vacancy_trust_scores'
);

-- 8. authenticated has exactly SELECT (R3.6: moderator access, RLS-gated — see moderator_role_rls.test.sql for row-visibility coverage)
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'vacancy_trust_scores' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on vacancy_trust_scores (R3.6 moderator grant, RLS-gated)'
);

-- 9. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_trust_scores' and grantee = 'anon'$$,
  'anon has no privileges on vacancy_trust_scores'
);

-- 10. service_role can insert a scoring run
set local role service_role;
select lives_ok(
  $$insert into vacancy_trust_scores (id, vacancy_id, status, score, policy_version)
    values ('ffffffff-3333-1111-1111-111111111111', 'eeeeeeee-3333-1111-1111-111111111111', 'VERIFIED', 87.5, 'r3-v1')$$,
  'service_role can insert into vacancy_trust_scores'
);

-- 11. an invalid status value is rejected by the check constraint
select throws_ok(
  $$insert into vacancy_trust_scores (vacancy_id, status, policy_version)
    values ('eeeeeeee-3333-1111-1111-111111111111', 'NOT_A_REAL_STATUS', 'r3-v1')$$,
  '23514',
  null,
  'an invalid vacancy_trust_scores.status value is rejected by the check constraint'
);
reset role;

-- 12. a non-moderator authenticated candidate gets an empty result, not an error (R3.6: grant exists, RLS filters)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-3333-1111-1111-111111111111';
select is_empty(
  $$select status from vacancy_trust_scores$$,
  'non-moderator candidate SELECT on vacancy_trust_scores is empty, not an error (R3.6 moderator RLS)'
);
reset role;

-- 13. anon cannot select vacancy_trust_scores
set local role anon;
select throws_ok(
  $$select status from vacancy_trust_scores$$,
  '42501',
  null,
  'anon cannot SELECT vacancy_trust_scores — no privilege granted'
);
reset role;

-- =========================================================================
-- Section C: vacancy_flags (reason codes on a scoring run — service_role
-- only)
-- =========================================================================

-- 14. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancy_flags'::regclass),
  'RLS is enabled on vacancy_flags'
);

-- 15. authenticated has exactly SELECT (R3.6: moderator access, RLS-gated)
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'vacancy_flags' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on vacancy_flags (R3.6 moderator grant, RLS-gated)'
);

-- 16. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_flags' and grantee = 'anon'$$,
  'anon has no privileges on vacancy_flags'
);

set local role service_role;

-- 17. service_role can insert a valid hard-block reason code
select lives_ok(
  $$insert into vacancy_flags (vacancy_trust_score_id, reason_code)
    values ('ffffffff-3333-1111-1111-111111111111', 'DOMAIN_MISMATCH_WITH_NO_EXPLANATION')$$,
  'service_role can insert a valid hard-block reason code into vacancy_flags'
);

-- 18. service_role can insert a valid positive reason code
select lives_ok(
  $$insert into vacancy_flags (vacancy_trust_score_id, reason_code)
    values ('ffffffff-3333-1111-1111-111111111111', 'ATS_POSTING_CONFIRMED')$$,
  'service_role can insert a valid positive reason code into vacancy_flags'
);

-- 19. an invalid reason_code is rejected by the check constraint
select throws_ok(
  $$insert into vacancy_flags (vacancy_trust_score_id, reason_code)
    values ('ffffffff-3333-1111-1111-111111111111', 'NOT_A_REAL_REASON_CODE')$$,
  '23514',
  null,
  'an invalid vacancy_flags.reason_code value is rejected by the check constraint'
);
reset role;

-- 20. a non-moderator authenticated candidate gets an empty result, not an error (R3.6)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-3333-1111-1111-111111111111';
select is_empty(
  $$select reason_code from vacancy_flags$$,
  'non-moderator candidate SELECT on vacancy_flags is empty, not an error (R3.6 moderator RLS)'
);
reset role;

-- 21. anon cannot select vacancy_flags
set local role anon;
select throws_ok(
  $$select reason_code from vacancy_flags$$,
  '42501',
  null,
  'anon cannot SELECT vacancy_flags — no privilege granted'
);
reset role;

-- =========================================================================
-- Section D: vacancy_evidence (evidence snapshots — service_role only)
-- =========================================================================

-- 22. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancy_evidence'::regclass),
  'RLS is enabled on vacancy_evidence'
);

-- 23. authenticated has exactly SELECT (R3.6: moderator access, RLS-gated)
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'vacancy_evidence' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on vacancy_evidence (R3.6 moderator grant, RLS-gated)'
);

-- 24. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_evidence' and grantee = 'anon'$$,
  'anon has no privileges on vacancy_evidence'
);

-- 25. service_role can insert an evidence snapshot
set local role service_role;
select lives_ok(
  $$insert into vacancy_evidence (vacancy_trust_score_id, evidence_type, payload)
    values ('ffffffff-3333-1111-1111-111111111111', 'domain_check', '{"domain": "trustco.example", "match": true}'::jsonb)$$,
  'service_role can insert into vacancy_evidence'
);
reset role;

-- 26. a non-moderator authenticated candidate gets an empty result, not an error (R3.6)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-3333-1111-1111-111111111111';
select is_empty(
  $$select evidence_type from vacancy_evidence$$,
  'non-moderator candidate SELECT on vacancy_evidence is empty, not an error (R3.6 moderator RLS)'
);
reset role;

-- 27. anon cannot select vacancy_evidence
set local role anon;
select throws_ok(
  $$select evidence_type from vacancy_evidence$$,
  '42501',
  null,
  'anon cannot SELECT vacancy_evidence — no privilege granted'
);
reset role;

select * from finish();
rollback;
