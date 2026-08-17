begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Fixture setup (as postgres, bypasses RLS — not under test; the
-- application_plans/application_attempts grants/RLS this fixture also
-- touches are covered in their own *_rls.test.sql files).
insert into auth.users (id, email) values ('11111111-9000-1111-1111-111111111111', 'candidate-a@test.local');
insert into candidate_profiles (id) values ('11111111-9000-1111-1111-111111111111');
insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('greenhouse', 'none', 'r2-v1', array['US']);
insert into companies (id, displayed_name, domain)
values ('cccccccc-9000-1111-1111-111111111111', 'Applyco', 'applyco.example');
insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-9000-1111-1111-111111111111', 'greenhouse', 'applyco');
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
values ('eeeeeeee-9000-1111-1111-111111111111', 'greenhouse', 'dddddddd-9000-1111-1111-111111111111', 'job-worker-1', 'https://applyco.example/jobs/1', 'Worker Test Role', 'cccccccc-9000-1111-1111-111111111111');
insert into application_plans (id, candidate_id, vacancy_id, gate_results)
values ('ffffffff-9000-1111-1111-111111111111', '11111111-9000-1111-1111-111111111111', 'eeeeeeee-9000-1111-1111-111111111111', '{}'::jsonb);

-- 1. anon cannot execute claim_application_attempt
set local role anon;
select throws_ok(
  $$select * from claim_application_attempt()$$,
  '42501',
  null,
  'anon cannot execute claim_application_attempt'
);
reset role;

-- 2. authenticated cannot execute claim_application_attempt
set local role authenticated;
select throws_ok(
  $$select * from claim_application_attempt()$$,
  '42501',
  null,
  'authenticated candidate cannot execute claim_application_attempt'
);
reset role;

set local role service_role;

insert into application_attempts (id, application_plan_id)
values ('11111111-8000-2222-2222-222222222222', 'ffffffff-9000-1111-1111-111111111111');

-- 3. service_role claims the pending attempt
select results_eq(
  $$select id, status, attempts from claim_application_attempt()$$,
  $$values ('11111111-8000-2222-2222-222222222222'::uuid, 'leased'::text, 1)$$,
  'service_role claims the pending attempt, marking it leased with attempts incremented'
);

-- 4. the same attempt is not claimable again immediately (lease still active)
select is_empty(
  $$select id from claim_application_attempt()$$,
  'A freshly-leased attempt is not claimable again while its lease is active'
);

-- 5. once the lease expires, the same attempt becomes claimable again
update application_attempts set leased_until = now() - interval '1 minute'
  where id = '11111111-8000-2222-2222-222222222222';
select results_eq(
  $$select id, attempts from claim_application_attempt()$$,
  $$values ('11111111-8000-2222-2222-222222222222'::uuid, 2)$$,
  'An attempt with an expired lease is reclaimed, incrementing attempts again'
);

-- 6. an attempt that has exhausted max_attempts is never claimed
update application_attempts
  set attempts = max_attempts, leased_until = now() - interval '1 minute'
  where id = '11111111-8000-2222-2222-222222222222';
select is_empty(
  $$select id from claim_application_attempt()$$,
  'An attempt at max_attempts is not claimed — dead-letter behavior'
);

-- 7. an attempt already marked succeeded is never reclaimed even with a stale lease
update application_attempts
  set status = 'succeeded', attempts = 1, leased_until = now() - interval '1 minute'
  where id = '11111111-8000-2222-2222-222222222222';
select is_empty(
  $$select id from claim_application_attempt()$$,
  'A succeeded attempt is never reclaimed regardless of leased_until'
);

-- 8. two attempts: only the oldest pending one is claimed (FIFO by created_at)
insert into application_attempts (id, application_plan_id, created_at)
values
  ('33333333-8000-2222-2222-222222222222', 'ffffffff-9000-1111-1111-111111111111', now() - interval '2 minutes'),
  ('44444444-8000-2222-2222-222222222222', 'ffffffff-9000-1111-1111-111111111111', now() - interval '1 minute');
select results_eq(
  $$select id from claim_application_attempt()$$,
  $$values ('33333333-8000-2222-2222-222222222222'::uuid)$$,
  'The oldest pending attempt is claimed first (FIFO)'
);

-- 9. no privileges leaked to authenticated/anon on the underlying table by this function
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'application_attempts' and grantee in ('anon', 'authenticated') and privilege_type != 'SELECT'$$,
  'Neither anon nor authenticated gained any mutation privilege on application_attempts from the RPC'
);

reset role;

select * from finish();
rollback;
