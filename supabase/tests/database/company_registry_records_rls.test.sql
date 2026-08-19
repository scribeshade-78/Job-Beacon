begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-9007-1111-1111-111111111111', 'candidate-a@test.local');

insert into candidate_profiles (id) values
  ('11111111-9007-1111-1111-111111111111');

insert into companies (id, displayed_name, domain)
values ('cccccccc-9007-1111-1111-111111111111', 'Applyco', 'applyco.example');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.company_registry_records'::regclass),
  'RLS is enabled on company_registry_records'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'company_registry_records' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on company_registry_records'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'company_registry_records' and grantee = 'anon'$$,
  'anon has no privileges on company_registry_records'
);

set local role service_role;

-- 4. service_role can insert a registry record
select lives_ok(
  $$insert into company_registry_records (id, company_id, registry_source, raw_payload)
    values ('eeeeeeee-9007-1111-1111-111111111111', 'cccccccc-9007-1111-1111-111111111111', 'mca_india', '{"cin": "U72900MH2015PTC123456", "companyName": "Applyco Private Limited"}'::jsonb)$$,
  'service_role can insert into company_registry_records'
);
reset role;

-- as an authenticated candidate (not the "owner" of anything — this is
-- public-within-the-app reference data, not candidate-owned)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9007-1111-1111-111111111111';

-- 5. Any authenticated candidate can select the registry record
select results_eq(
  $$select registry_source from company_registry_records where id = 'eeeeeeee-9007-1111-1111-111111111111'$$,
  $$values ('mca_india'::text)$$,
  'Any authenticated candidate can select a company registry record'
);

-- 6. authenticated cannot INSERT — no grant exists
select throws_ok(
  $$insert into company_registry_records (company_id, registry_source, raw_payload)
    values ('cccccccc-9007-1111-1111-111111111111', 'mca_india', '{}'::jsonb)$$,
  '42501',
  null,
  'authenticated cannot INSERT into company_registry_records'
);

-- 7. authenticated cannot UPDATE — no grant exists
select throws_ok(
  $$update company_registry_records set registry_source = 'fake' where id = 'eeeeeeee-9007-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated cannot UPDATE company_registry_records'
);

-- 8. authenticated cannot DELETE — no grant exists
select throws_ok(
  $$delete from company_registry_records where id = 'eeeeeeee-9007-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated cannot DELETE company_registry_records'
);
reset role;

-- 9. anon cannot select company_registry_records
set local role anon;
select throws_ok(
  $$select registry_source from company_registry_records$$,
  '42501',
  null,
  'anon cannot SELECT company_registry_records — no privilege granted'
);
reset role;

-- 10. Deleting the companies row cascades to delete its registry records
delete from companies where id = 'cccccccc-9007-1111-1111-111111111111';
select is_empty(
  $$select id from company_registry_records where company_id = 'cccccccc-9007-1111-1111-111111111111'$$,
  'Deleting the companies row cascades to delete its registry records'
);

select * from finish();
rollback;
