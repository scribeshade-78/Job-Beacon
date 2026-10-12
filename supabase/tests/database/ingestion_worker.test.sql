begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into source_policies (source_code, authentication_method, policy_version)
values ('greenhouse', 'none', 'r2-v1');

insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-1111-1111-1111-111111111111', 'greenhouse', 'acme');

-- 1. anon cannot execute claim_ingestion_job
set local role anon;
select throws_ok(
  $$select * from claim_ingestion_job()$$,
  '42501',
  null,
  'anon cannot execute claim_ingestion_job'
);
reset role;

-- 2. authenticated cannot execute claim_ingestion_job
set local role authenticated;
select throws_ok(
  $$select * from claim_ingestion_job()$$,
  '42501',
  null,
  'authenticated candidate cannot execute claim_ingestion_job'
);
reset role;

set local role service_role;

insert into ingestion_jobs (id, source_code, vacancy_source_id)
values ('11111111-2222-2222-2222-222222222222', 'greenhouse', 'dddddddd-1111-1111-1111-111111111111');

-- 3. service_role claims the pending job
select results_eq(
  $$select id, status, attempts from claim_ingestion_job()$$,
  $$values ('11111111-2222-2222-2222-222222222222'::uuid, 'leased'::text, 1)$$,
  'service_role claims the pending job, marking it leased with attempts incremented'
);

-- 4. the same job is not claimable again immediately (lease still active)
select is_empty(
  $$select id from claim_ingestion_job()$$,
  'A freshly-leased job is not claimable again while its lease is active'
);

-- 5. once the lease expires, the same job becomes claimable again
update ingestion_jobs set leased_until = now() - interval '1 minute'
  where id = '11111111-2222-2222-2222-222222222222';
select results_eq(
  $$select id, attempts from claim_ingestion_job()$$,
  $$values ('11111111-2222-2222-2222-222222222222'::uuid, 2)$$,
  'A job with an expired lease is reclaimed, incrementing attempts again'
);

-- 6. a job that has exhausted max_attempts is never claimed
update ingestion_jobs
  set attempts = max_attempts, leased_until = now() - interval '1 minute'
  where id = '11111111-2222-2222-2222-222222222222';
select is_empty(
  $$select id from claim_ingestion_job()$$,
  'A job at max_attempts is not claimed — dead-letter behavior'
);

-- 7. marking a job done removes it from future claims even with a stale lease
update ingestion_jobs
  set status = 'done', attempts = 1, leased_until = now() - interval '1 minute'
  where id = '11111111-2222-2222-2222-222222222222';
select is_empty(
  $$select id from claim_ingestion_job()$$,
  'A done job is never reclaimed regardless of lease_until'
);

-- 8. two jobs: only the oldest pending one is claimed (FIFO by created_at)
insert into ingestion_jobs (id, source_code, vacancy_source_id, created_at)
values
  ('33333333-2222-2222-2222-222222222222', 'greenhouse', 'dddddddd-1111-1111-1111-111111111111', now() - interval '2 minutes'),
  ('44444444-2222-2222-2222-222222222222', 'greenhouse', 'dddddddd-1111-1111-1111-111111111111', now() - interval '1 minute');
select results_eq(
  $$select id from claim_ingestion_job()$$,
  $$values ('33333333-2222-2222-2222-222222222222'::uuid)$$,
  'The oldest pending job is claimed first (FIFO)'
);

-- 9. no privileges leaked to authenticated/anon on the underlying table by this function
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'ingestion_jobs' and grantee in ('anon', 'authenticated')$$,
  'Neither anon nor authenticated gained any table privilege from the RPC'
);

reset role;

select * from finish();
rollback;
