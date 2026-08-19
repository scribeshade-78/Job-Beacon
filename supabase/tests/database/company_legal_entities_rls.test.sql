begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-9006-1111-1111-111111111111', 'candidate-a@test.local');

insert into candidate_profiles (id) values
  ('11111111-9006-1111-1111-111111111111');

insert into companies (id, displayed_name, domain)
values ('cccccccc-9006-1111-1111-111111111111', 'Applyco', 'applyco.example');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.company_legal_entities'::regclass),
  'RLS is enabled on company_legal_entities'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'company_legal_entities' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on company_legal_entities'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'company_legal_entities' and grantee = 'anon'$$,
  'anon has no privileges on company_legal_entities'
);

set local role service_role;

-- 4. service_role can insert a legal entity
select lives_ok(
  $$insert into company_legal_entities (id, company_id, jurisdiction, registry_identifier, legal_name, registration_status, registration_date, company_category, company_class, authorized_capital, paid_up_capital, capital_currency, registered_region, registrar)
    values ('dddddddd-9006-1111-1111-111111111111', 'cccccccc-9006-1111-1111-111111111111', 'IN', 'U72900MH2015PTC123456', 'Applyco Private Limited', 'Active', '2015-04-01', 'Company limited by Shares', 'Private', 5000000, 3200000, 'INR', 'Maharashtra', 'RoC-Mumbai')$$,
  'service_role can insert into company_legal_entities'
);
reset role;

-- as an authenticated candidate (not the "owner" of anything — this is
-- public-within-the-app reference data, not candidate-owned)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9006-1111-1111-111111111111';

-- 5. Any authenticated candidate can select the legal entity
select results_eq(
  $$select legal_name from company_legal_entities where id = 'dddddddd-9006-1111-1111-111111111111'$$,
  $$values ('Applyco Private Limited'::text)$$,
  'Any authenticated candidate can select a company legal entity'
);

-- 6. authenticated cannot INSERT — no grant exists
select throws_ok(
  $$insert into company_legal_entities (company_id, jurisdiction, registry_identifier, legal_name)
    values ('cccccccc-9006-1111-1111-111111111111', 'IN', 'FAKE123', 'Fraud')$$,
  '42501',
  null,
  'authenticated cannot INSERT into company_legal_entities'
);

-- 7. authenticated cannot UPDATE — no grant exists
select throws_ok(
  $$update company_legal_entities set legal_name = 'Fraud' where id = 'dddddddd-9006-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated cannot UPDATE company_legal_entities'
);

-- 8. authenticated cannot DELETE — no grant exists
select throws_ok(
  $$delete from company_legal_entities where id = 'dddddddd-9006-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated cannot DELETE company_legal_entities'
);
reset role;

-- 9. anon cannot select company_legal_entities
set local role anon;
select throws_ok(
  $$select legal_name from company_legal_entities$$,
  '42501',
  null,
  'anon cannot SELECT company_legal_entities — no privilege granted'
);
reset role;

-- 10. Deleting the companies row cascades to delete its legal entities
delete from companies where id = 'cccccccc-9006-1111-1111-111111111111';
select is_empty(
  $$select id from company_legal_entities where company_id = 'cccccccc-9006-1111-1111-111111111111'$$,
  'Deleting the companies row cascades to delete its legal entities'
);

select * from finish();
rollback;
