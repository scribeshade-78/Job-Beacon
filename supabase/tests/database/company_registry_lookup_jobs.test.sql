begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Fixture setup (as postgres, bypasses RLS — not under test; companies'
-- own grants/RLS are covered in its own migration/tests).
insert into companies (id, displayed_name, domain)
values ('cccccccc-9008-1111-1111-111111111111', 'Applyco', 'applyco.example');

-- 1. anon cannot execute claim_company_registry_lookup_job
set local role anon;
select throws_ok(
  $$select * from claim_company_registry_lookup_job()$$,
  '42501',
  null,
  'anon cannot execute claim_company_registry_lookup_job'
);
reset role;

-- 2. authenticated cannot execute claim_company_registry_lookup_job
set local role authenticated;
select throws_ok(
  $$select * from claim_company_registry_lookup_job()$$,
  '42501',
  null,
  'authenticated cannot execute claim_company_registry_lookup_job'
);
reset role;

set local role service_role;

insert into company_registry_lookup_jobs (id, company_id, cin)
values ('11111111-8100-2222-2222-222222222222', 'cccccccc-9008-1111-1111-111111111111', 'U72900MH2015PTC123456');

-- 3. service_role claims the pending job
select results_eq(
  $$select id, status, attempts from claim_company_registry_lookup_job()$$,
  $$values ('11111111-8100-2222-2222-222222222222'::uuid, 'leased'::text, 1)$$,
  'service_role claims the pending job, marking it leased with attempts incremented'
);

-- 4. the same job is not claimable again immediately (lease still active)
select is_empty(
  $$select id from claim_company_registry_lookup_job()$$,
  'A freshly-leased job is not claimable again while its lease is active'
);

-- 5. once the lease expires, the same job becomes claimable again
update company_registry_lookup_jobs set leased_until = now() - interval '1 minute'
  where id = '11111111-8100-2222-2222-222222222222';
select results_eq(
  $$select id, attempts from claim_company_registry_lookup_job()$$,
  $$values ('11111111-8100-2222-2222-222222222222'::uuid, 2)$$,
  'A job with an expired lease is reclaimed, incrementing attempts again'
);

-- 6. a job that has exhausted max_attempts is never claimed
update company_registry_lookup_jobs
  set attempts = max_attempts, leased_until = now() - interval '1 minute'
  where id = '11111111-8100-2222-2222-222222222222';
select is_empty(
  $$select id from claim_company_registry_lookup_job()$$,
  'A job at max_attempts is not claimed — dead-letter behavior'
);

-- 7. a job already marked done is never reclaimed even with a stale lease
update company_registry_lookup_jobs
  set status = 'done', attempts = 1, leased_until = now() - interval '1 minute'
  where id = '11111111-8100-2222-2222-222222222222';
select is_empty(
  $$select id from claim_company_registry_lookup_job()$$,
  'A done job is never reclaimed regardless of leased_until'
);

-- 8. two jobs: only the oldest pending one is claimed (FIFO by created_at)
insert into company_registry_lookup_jobs (id, company_id, cin, created_at)
values
  ('33333333-8100-2222-2222-222222222222', 'cccccccc-9008-1111-1111-111111111111', 'U11111111111111111111', now() - interval '2 minutes'),
  ('44444444-8100-2222-2222-222222222222', 'cccccccc-9008-1111-1111-111111111111', 'U22222222222222222222', now() - interval '1 minute');
select results_eq(
  $$select id from claim_company_registry_lookup_job()$$,
  $$values ('33333333-8100-2222-2222-222222222222'::uuid)$$,
  'The oldest pending job is claimed first (FIFO)'
);

-- 9. no privileges of any kind leaked to anon/authenticated on the
-- underlying table — unlike application_attempts, candidates have no
-- read surface here at all; this is purely internal worker state.
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'company_registry_lookup_jobs' and grantee in ('anon', 'authenticated')$$,
  'Neither anon nor authenticated has any privilege on company_registry_lookup_jobs'
);

reset role;

select * from finish();
rollback;
