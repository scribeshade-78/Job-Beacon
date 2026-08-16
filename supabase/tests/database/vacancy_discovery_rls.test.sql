begin;
create extension if not exists pgtap with schema extensions;
select plan(73);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'candidate-a@test.local');

insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('greenhouse', 'none', 'r2-v1', array['US']);

insert into companies (id, displayed_name, domain)
values ('cccccccc-1111-1111-1111-111111111111', 'Acme Corp', 'acme.example');

insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-1111-1111-1111-111111111111', 'greenhouse', 'acme');

-- =========================================================================
-- Part 1: candidate-facing tables (vacancies, companies,
-- vacancy_source_records) — full a-f coverage per table.
-- =========================================================================

-- --- vacancies ---

-- 1. RLS enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancies'::regclass),
  'RLS is enabled on vacancies'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'vacancies' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on vacancies'
);

-- 3. anon has no privileges
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancies' and grantee = 'anon'$$,
  'anon has no privileges on vacancies'
);

-- (f) service_role can insert (privileged ingestion write)
set local role service_role;
select lives_ok(
  $$insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
    values ('eeeeeeee-1111-1111-1111-111111111111', 'greenhouse', 'dddddddd-1111-1111-1111-111111111111', 'job-1', 'https://acme.example/jobs/1', 'Backend Engineer', 'cccccccc-1111-1111-1111-111111111111')$$,
  'service_role can insert into vacancies'
);
reset role;

-- (a) authenticated candidate SELECT works
set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select results_eq(
  $$select raw_title from vacancies where id = 'eeeeeeee-1111-1111-1111-111111111111'$$,
  $$values ('Backend Engineer'::text)$$,
  'authenticated candidate can SELECT vacancies'
);

-- (c) authenticated candidate cannot INSERT
select throws_ok(
  $$insert into vacancies (source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title)
    values ('greenhouse', 'dddddddd-1111-1111-1111-111111111111', 'job-2', 'https://acme.example/jobs/2', 'Should Fail')$$,
  '42501',
  null,
  'authenticated candidate cannot INSERT into vacancies'
);

-- (d) authenticated candidate cannot UPDATE
select throws_ok(
  $$update vacancies set raw_title = 'Hacked' where id = 'eeeeeeee-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated candidate cannot UPDATE vacancies'
);

-- (e) authenticated candidate cannot DELETE
select throws_ok(
  $$delete from vacancies where id = 'eeeeeeee-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated candidate cannot DELETE from vacancies'
);
reset role;

-- (b) anon SELECT is denied outright
set local role anon;
select throws_ok(
  $$select raw_title from vacancies$$,
  '42501',
  null,
  'anon SELECT on vacancies is denied — no privilege granted'
);
reset role;

-- (f) service_role can update/delete too
set local role service_role;
select lives_ok(
  $$update vacancies set last_seen_at = now() where id = 'eeeeeeee-1111-1111-1111-111111111111'$$,
  'service_role can update vacancies'
);
select lives_ok(
  $$delete from vacancies where id = 'eeeeeeee-1111-1111-1111-111111111111'$$,
  'service_role can delete from vacancies'
);
-- Re-insert for the tables below that FK-reference this vacancy.
select lives_ok(
  $$insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
    values ('eeeeeeee-1111-1111-1111-111111111111', 'greenhouse', 'dddddddd-1111-1111-1111-111111111111', 'job-1', 'https://acme.example/jobs/1', 'Backend Engineer', 'cccccccc-1111-1111-1111-111111111111')$$,
  'service_role can re-insert the fixture vacancy'
);
reset role;

-- --- companies ---

select ok(
  (select relrowsecurity from pg_class where oid = 'public.companies'::regclass),
  'RLS is enabled on companies'
);
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'companies' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on companies'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'companies' and grantee = 'anon'$$,
  'anon has no privileges on companies'
);

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select results_eq(
  $$select displayed_name from companies where id = 'cccccccc-1111-1111-1111-111111111111'$$,
  $$values ('Acme Corp'::text)$$,
  'authenticated candidate can SELECT companies'
);
select throws_ok(
  $$insert into companies (displayed_name) values ('Should Fail')$$,
  '42501',
  null,
  'authenticated candidate cannot INSERT into companies'
);
select throws_ok(
  $$update companies set displayed_name = 'Hacked' where id = 'cccccccc-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated candidate cannot UPDATE companies'
);
select throws_ok(
  $$delete from companies where id = 'cccccccc-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated candidate cannot DELETE from companies'
);
reset role;

set local role anon;
select throws_ok(
  $$select displayed_name from companies$$,
  '42501',
  null,
  'anon SELECT on companies is denied — no privilege granted'
);
reset role;

set local role service_role;
select lives_ok(
  $$update companies set domain = 'acme2.example' where id = 'cccccccc-1111-1111-1111-111111111111'$$,
  'service_role can update companies'
);
reset role;

-- --- vacancy_source_records ---

select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancy_source_records'::regclass),
  'RLS is enabled on vacancy_source_records'
);
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'vacancy_source_records' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on vacancy_source_records'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_source_records' and grantee = 'anon'$$,
  'anon has no privileges on vacancy_source_records'
);

set local role service_role;
select lives_ok(
  $$insert into vacancy_source_records (id, vacancy_id, source_code, source_vacancy_id, authoritative_url)
    values ('ffffffff-1111-1111-1111-111111111111', 'eeeeeeee-1111-1111-1111-111111111111', 'greenhouse', 'job-1', 'https://acme.example/jobs/1')$$,
  'service_role can insert into vacancy_source_records'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select results_eq(
  $$select source_code from vacancy_source_records where vacancy_id = 'eeeeeeee-1111-1111-1111-111111111111'$$,
  $$values ('greenhouse'::text)$$,
  'authenticated candidate can SELECT vacancy_source_records'
);
select throws_ok(
  $$insert into vacancy_source_records (vacancy_id, source_code, source_vacancy_id, authoritative_url)
    values ('eeeeeeee-1111-1111-1111-111111111111', 'greenhouse', 'job-99', 'https://acme.example/jobs/99')$$,
  '42501',
  null,
  'authenticated candidate cannot INSERT into vacancy_source_records'
);
select throws_ok(
  $$update vacancy_source_records set authoritative_url = 'https://evil.example' where id = 'ffffffff-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated candidate cannot UPDATE vacancy_source_records'
);
select throws_ok(
  $$delete from vacancy_source_records where id = 'ffffffff-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated candidate cannot DELETE from vacancy_source_records'
);
reset role;

set local role anon;
select throws_ok(
  $$select source_code from vacancy_source_records$$,
  '42501',
  null,
  'anon SELECT on vacancy_source_records is denied — no privilege granted'
);
reset role;

-- =========================================================================
-- Part 2: internal-only tables — no candidate access at all (SELECT
-- included), anon denied, service_role works. One representative table
-- write test each, plus grants checks for every table.
-- =========================================================================

-- --- source_policies ---
select ok(
  (select relrowsecurity from pg_class where oid = 'public.source_policies'::regclass),
  'RLS is enabled on source_policies'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'source_policies' and grantee = 'authenticated'$$,
  'authenticated has no privileges on source_policies (internal-only)'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'source_policies' and grantee = 'anon'$$,
  'anon has no privileges on source_policies'
);
set local role authenticated;
select throws_ok(
  $$select source_code from source_policies$$,
  '42501',
  null,
  'authenticated candidate cannot SELECT source_policies'
);
reset role;
set local role anon;
select throws_ok(
  $$select source_code from source_policies$$,
  '42501',
  null,
  'anon cannot SELECT source_policies'
);
reset role;
set local role service_role;
select lives_ok(
  $$update source_policies set policy_version = 'r2-v2' where source_code = 'greenhouse'$$,
  'service_role can update source_policies'
);
reset role;

-- --- vacancy_sources ---
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancy_sources'::regclass),
  'RLS is enabled on vacancy_sources'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_sources' and grantee = 'authenticated'$$,
  'authenticated has no privileges on vacancy_sources (internal-only)'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_sources' and grantee = 'anon'$$,
  'anon has no privileges on vacancy_sources'
);
set local role authenticated;
select throws_ok(
  $$select target_key from vacancy_sources$$,
  '42501',
  null,
  'authenticated candidate cannot SELECT vacancy_sources'
);
reset role;
set local role anon;
select throws_ok(
  $$select target_key from vacancy_sources$$,
  '42501',
  null,
  'anon cannot SELECT vacancy_sources'
);
reset role;
set local role service_role;
select lives_ok(
  $$update vacancy_sources set enabled = false where id = 'dddddddd-1111-1111-1111-111111111111'$$,
  'service_role can update vacancy_sources'
);
select lives_ok(
  $$update vacancy_sources set enabled = true where id = 'dddddddd-1111-1111-1111-111111111111'$$,
  'service_role can re-enable vacancy_sources'
);
reset role;

-- --- vacancy_versions ---
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancy_versions'::regclass),
  'RLS is enabled on vacancy_versions'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_versions' and grantee = 'authenticated'$$,
  'authenticated has no privileges on vacancy_versions (internal-only)'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_versions' and grantee = 'anon'$$,
  'anon has no privileges on vacancy_versions'
);
set local role authenticated;
select throws_ok(
  $$select raw_payload from vacancy_versions$$,
  '42501',
  null,
  'authenticated candidate cannot SELECT vacancy_versions'
);
reset role;
set local role anon;
select throws_ok(
  $$select raw_payload from vacancy_versions$$,
  '42501',
  null,
  'anon cannot SELECT vacancy_versions'
);
reset role;
set local role service_role;
select lives_ok(
  $$insert into vacancy_versions (vacancy_id, raw_payload, content_hash)
    values ('eeeeeeee-1111-1111-1111-111111111111', '{"title":"Backend Engineer"}'::jsonb, 'hash1')$$,
  'service_role can insert into vacancy_versions'
);
-- immutable: no UPDATE/DELETE grant even for service_role
select throws_ok(
  $$update vacancy_versions set content_hash = 'hash2' where vacancy_id = 'eeeeeeee-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'service_role cannot UPDATE vacancy_versions — no grant, immutable by design'
);
reset role;

-- --- vacancy_fingerprints ---
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancy_fingerprints'::regclass),
  'RLS is enabled on vacancy_fingerprints'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_fingerprints' and grantee = 'authenticated'$$,
  'authenticated has no privileges on vacancy_fingerprints (internal-only)'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_fingerprints' and grantee = 'anon'$$,
  'anon has no privileges on vacancy_fingerprints'
);
set local role authenticated;
select throws_ok(
  $$select fingerprint from vacancy_fingerprints$$,
  '42501',
  null,
  'authenticated candidate cannot SELECT vacancy_fingerprints'
);
reset role;
set local role service_role;
select lives_ok(
  $$insert into vacancy_fingerprints (vacancy_id, fingerprint)
    values ('eeeeeeee-1111-1111-1111-111111111111', 'acme-backend-engineer-us-2026w33')$$,
  'service_role can insert into vacancy_fingerprints'
);
reset role;

-- --- source_health_events ---
select ok(
  (select relrowsecurity from pg_class where oid = 'public.source_health_events'::regclass),
  'RLS is enabled on source_health_events'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'source_health_events' and grantee = 'authenticated'$$,
  'authenticated has no privileges on source_health_events (internal-only)'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'source_health_events' and grantee = 'anon'$$,
  'anon has no privileges on source_health_events'
);
set local role authenticated;
select throws_ok(
  $$select status from source_health_events$$,
  '42501',
  null,
  'authenticated candidate cannot SELECT source_health_events'
);
reset role;
set local role service_role;
select lives_ok(
  $$insert into source_health_events (source_code, vacancy_source_id, status, vacancies_fetched, duration_ms)
    values ('greenhouse', 'dddddddd-1111-1111-1111-111111111111', 'success', 1, 250)$$,
  'service_role can insert into source_health_events'
);
reset role;

-- --- ingestion_jobs ---
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ingestion_jobs'::regclass),
  'RLS is enabled on ingestion_jobs'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'ingestion_jobs' and grantee = 'authenticated'$$,
  'authenticated has no privileges on ingestion_jobs (internal-only)'
);
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'ingestion_jobs' and grantee = 'anon'$$,
  'anon has no privileges on ingestion_jobs'
);
set local role authenticated;
select throws_ok(
  $$select status from ingestion_jobs$$,
  '42501',
  null,
  'authenticated candidate cannot SELECT ingestion_jobs'
);
reset role;
set local role service_role;
select lives_ok(
  $$insert into ingestion_jobs (id, source_code, vacancy_source_id)
    values ('99999999-1111-1111-1111-111111111111', 'greenhouse', 'dddddddd-1111-1111-1111-111111111111')$$,
  'service_role can insert into ingestion_jobs'
);
select lives_ok(
  $$update ingestion_jobs set status = 'leased', leased_until = now() + interval '5 minutes'
    where id = '99999999-1111-1111-1111-111111111111'$$,
  'service_role can lease an ingestion_jobs row'
);
select lives_ok(
  $$delete from ingestion_jobs where id = '99999999-1111-1111-1111-111111111111'$$,
  'service_role can delete from ingestion_jobs'
);
reset role;

-- =========================================================================
-- Part 3: cascade + uniqueness sanity checks
-- =========================================================================

set local role service_role;

-- Dedup rule 1 (§11.3): exact source ID match rejected outright.
select throws_ok(
  $$insert into vacancies (source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title)
    values ('greenhouse', 'dddddddd-1111-1111-1111-111111111111', 'job-1', 'https://acme.example/jobs/1-dup', 'Duplicate')$$,
  '23505',
  null,
  'Duplicate (source_code, source_vacancy_id) is rejected — dedup rule 1'
);

-- Dedup rule 2 (§11.3): canonical URL match rejected outright.
select throws_ok(
  $$insert into vacancies (source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title)
    values ('greenhouse', 'dddddddd-1111-1111-1111-111111111111', 'job-1-different-id', 'https://acme.example/jobs/1', 'Duplicate URL')$$,
  '23505',
  null,
  'Duplicate authoritative_url is rejected — dedup rule 2'
);

-- Deleting the vacancy cascades to versions, source_records, fingerprints.
select lives_ok(
  $$delete from vacancies where id = 'eeeeeeee-1111-1111-1111-111111111111'$$,
  'service_role can delete the fixture vacancy for cascade check'
);
select is_empty(
  $$select id from vacancy_versions where vacancy_id = 'eeeeeeee-1111-1111-1111-111111111111'$$,
  'Deleting a vacancy cascades to vacancy_versions'
);
select is_empty(
  $$select id from vacancy_source_records where vacancy_id = 'eeeeeeee-1111-1111-1111-111111111111'$$,
  'Deleting a vacancy cascades to vacancy_source_records'
);
select is_empty(
  $$select vacancy_id from vacancy_fingerprints where vacancy_id = 'eeeeeeee-1111-1111-1111-111111111111'$$,
  'Deleting a vacancy cascades to vacancy_fingerprints'
);

reset role;

select * from finish();
rollback;
