begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-9004-1111-1111-111111111111', 'candidate-a@test.local');

insert into candidate_profiles (id) values
  ('11111111-9004-1111-1111-111111111111');

insert into companies (id, displayed_name, domain)
values ('cccccccc-9004-1111-1111-111111111111', 'Applyco', 'applyco.example');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.company_profiles'::regclass),
  'RLS is enabled on company_profiles'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'company_profiles' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on company_profiles'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'company_profiles' and grantee = 'anon'$$,
  'anon has no privileges on company_profiles'
);

set local role service_role;

-- 4. service_role can insert a company profile
select lives_ok(
  $$insert into company_profiles (company_id, headquarters_country, operating_countries, industry, founded_year, employee_size_range, public_private_status, official_social_links)
    values ('cccccccc-9004-1111-1111-111111111111', 'IN', array['IN', 'US'], 'Software', 2015, '51-200', 'private', '{"linkedin": "https://linkedin.com/company/applyco"}'::jsonb)$$,
  'service_role can insert into company_profiles'
);
reset role;

-- as an authenticated candidate (not the "owner" of anything — this is
-- public-within-the-app data, not candidate-owned)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9004-1111-1111-111111111111';

-- 5. Any authenticated candidate can select the company's profile
select results_eq(
  $$select industry from company_profiles where company_id = 'cccccccc-9004-1111-1111-111111111111'$$,
  $$values ('Software'::text)$$,
  'Any authenticated candidate can select a company profile'
);

-- 6. authenticated cannot INSERT — no grant exists
select throws_ok(
  $$insert into company_profiles (company_id, industry) values ('cccccccc-9004-1111-1111-111111111111', 'Fraud')$$,
  '42501',
  null,
  'authenticated cannot INSERT into company_profiles'
);

-- 7. authenticated cannot UPDATE — no grant exists
select throws_ok(
  $$update company_profiles set industry = 'Fraud' where company_id = 'cccccccc-9004-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated cannot UPDATE company_profiles'
);

-- 8. authenticated cannot DELETE — no grant exists
select throws_ok(
  $$delete from company_profiles where company_id = 'cccccccc-9004-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated cannot DELETE company_profiles'
);
reset role;

-- 9. anon cannot select company_profiles
set local role anon;
select throws_ok(
  $$select company_id from company_profiles$$,
  '42501',
  null,
  'anon cannot SELECT company_profiles — no privilege granted'
);
reset role;

-- 10. Deleting the companies row cascades to delete its profile
delete from companies where id = 'cccccccc-9004-1111-1111-111111111111';
select is_empty(
  $$select company_id from company_profiles where company_id = 'cccccccc-9004-1111-1111-111111111111'$$,
  'Deleting the companies row cascades to delete its profile'
);

select * from finish();
rollback;
