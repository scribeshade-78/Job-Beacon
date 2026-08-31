begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- Fixture (as postgres).
insert into auth.users (id, email) values
  ('aaaaaaaa-9212-1111-1111-111111111111', 'job-a@test.local');
insert into candidate_profiles (id) values
  ('aaaaaaaa-9212-1111-1111-111111111111');
insert into source_policies (source_code, authentication_method, policy_version)
values ('greenhouse', 'none', 'r2-v1');
insert into vacancy_sources (id, source_code, target_key)
values ('cccccccc-9212-1111-1111-111111111111', 'greenhouse', 'acme');
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title)
values (
  'dddddddd-9212-1111-1111-111111111111',
  'greenhouse', 'cccccccc-9212-1111-1111-111111111111', 'gh-1',
  'https://boards.greenhouse.io/acme/jobs/1', 'Senior Platform Engineer'
);

-- 1. RLS enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.fit_analysis_jobs'::regclass),
  'RLS is enabled on fit_analysis_jobs'
);

-- 2. neither anon nor authenticated has any table privilege
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'fit_analysis_jobs' and grantee in ('anon', 'authenticated')$$,
  'anon and authenticated have no privileges on fit_analysis_jobs'
);

-- 3. anon cannot execute claim_fit_analysis_job
set local role anon;
select throws_ok(
  $$select * from claim_fit_analysis_job()$$,
  '42501', null,
  'anon cannot execute claim_fit_analysis_job'
);
reset role;

-- 4. authenticated cannot execute claim_fit_analysis_job
set local role authenticated;
select throws_ok(
  $$select * from claim_fit_analysis_job()$$,
  '42501', null,
  'authenticated cannot execute claim_fit_analysis_job'
);
reset role;

set local role service_role;

insert into fit_analysis_jobs (id, candidate_id, vacancy_id)
values ('11111111-9212-2222-2222-222222222222', 'aaaaaaaa-9212-1111-1111-111111111111', 'dddddddd-9212-1111-1111-111111111111');

-- 5. service_role claims the pending job, marking it leased + attempts incremented
select results_eq(
  $$select id, status, attempts from claim_fit_analysis_job()$$,
  $$values ('11111111-9212-2222-2222-222222222222'::uuid, 'leased'::text, 1)$$,
  'service_role claims the pending job'
);

-- 6. a freshly-leased job is not re-claimable while its lease is active
select is_empty(
  $$select id from claim_fit_analysis_job()$$,
  'a freshly-leased job is not claimable again while its lease is active'
);

-- 7. an expired lease makes the job claimable again, incrementing attempts
update fit_analysis_jobs set leased_until = now() - interval '1 minute'
  where id = '11111111-9212-2222-2222-222222222222';
select results_eq(
  $$select id, attempts from claim_fit_analysis_job()$$,
  $$values ('11111111-9212-2222-2222-222222222222'::uuid, 2)$$,
  'a job with an expired lease is reclaimed'
);

-- 8. a job at max_attempts is never claimed (dead-letter)
update fit_analysis_jobs
  set attempts = max_attempts, leased_until = now() - interval '1 minute'
  where id = '11111111-9212-2222-2222-222222222222';
select is_empty(
  $$select id from claim_fit_analysis_job()$$,
  'a job at max_attempts is not claimed'
);

-- 9. a done job is never reclaimed regardless of leased_until
update fit_analysis_jobs
  set status = 'done', attempts = 1, leased_until = now() - interval '1 minute'
  where id = '11111111-9212-2222-2222-222222222222';
select is_empty(
  $$select id from claim_fit_analysis_job()$$,
  'a done job is never reclaimed'
);

-- 10. one job row per (candidate, vacancy)
select throws_ok(
  $$insert into fit_analysis_jobs (candidate_id, vacancy_id)
    values ('aaaaaaaa-9212-1111-1111-111111111111', 'dddddddd-9212-1111-1111-111111111111')$$,
  '23505', null,
  'a second job row for the same (candidate, vacancy) is rejected'
);
reset role;

select * from finish();
rollback;
