begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-9005-1111-1111-111111111111', 'candidate-a@test.local');

insert into candidate_profiles (id) values
  ('11111111-9005-1111-1111-111111111111');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.salary_benchmarks'::regclass),
  'RLS is enabled on salary_benchmarks'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'salary_benchmarks' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on salary_benchmarks'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'salary_benchmarks' and grantee = 'anon'$$,
  'anon has no privileges on salary_benchmarks'
);

set local role service_role;

-- 4. service_role can insert a salary benchmark
select lives_ok(
  $$insert into salary_benchmarks (id, role_label, region, currency, salary_interval, salary_min, salary_max, benchmark_source, effective_date, analytical_currency, analytical_salary_min, analytical_salary_max)
    values ('bbbbbbbb-9005-1111-1111-111111111111', 'Backend Engineer', 'IN', 'INR', 'year', 800000, 1800000, 'India Labour Bureau', '2026-07-01', 'USD', 9600, 21600)$$,
  'service_role can insert into salary_benchmarks'
);

-- 5. an invalid salary_interval is rejected by the check constraint
select throws_ok(
  $$insert into salary_benchmarks (role_label, currency, salary_interval, benchmark_source)
    values ('Backend Engineer', 'INR', 'fortnight', 'India Labour Bureau')$$,
  '23514',
  null,
  'An undefined salary_interval is rejected by the check constraint'
);
reset role;

-- as an authenticated candidate (not the "owner" of anything — this is
-- public-within-the-app reference data, not candidate-owned)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9005-1111-1111-111111111111';

-- 6. Any authenticated candidate can select the benchmark
select results_eq(
  $$select role_label from salary_benchmarks where id = 'bbbbbbbb-9005-1111-1111-111111111111'$$,
  $$values ('Backend Engineer'::text)$$,
  'Any authenticated candidate can select a salary benchmark'
);

-- 7. authenticated cannot INSERT — no grant exists
select throws_ok(
  $$insert into salary_benchmarks (role_label, currency, salary_interval, benchmark_source)
    values ('Fraud', 'INR', 'year', 'Fake')$$,
  '42501',
  null,
  'authenticated cannot INSERT into salary_benchmarks'
);

-- 8. authenticated cannot UPDATE — no grant exists
select throws_ok(
  $$update salary_benchmarks set role_label = 'Fraud' where id = 'bbbbbbbb-9005-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated cannot UPDATE salary_benchmarks'
);

-- 9. authenticated cannot DELETE — no grant exists
select throws_ok(
  $$delete from salary_benchmarks where id = 'bbbbbbbb-9005-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated cannot DELETE salary_benchmarks'
);
reset role;

-- 10. anon cannot select salary_benchmarks
set local role anon;
select throws_ok(
  $$select role_label from salary_benchmarks$$,
  '42501',
  null,
  'anon cannot SELECT salary_benchmarks — no privilege granted'
);
reset role;

select * from finish();
rollback;
