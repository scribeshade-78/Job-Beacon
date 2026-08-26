begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-9012-1111-1111-111111111111', 'employer-a@test.local'),
  ('22222222-9012-1111-1111-111111111111', 'candidate-b@test.local'),
  ('44444444-9012-1111-1111-111111111111', 'moderator@test.local');

insert into public.companies (id, displayed_name, domain) values
  ('33333333-9012-1111-1111-111111111111', 'Acme Corp', 'acme.test');

insert into public.employer_claims (id, user_id, company_id, status, representative_name, representative_role) values
  ('cccccccc-9012-1111-1111-111111111111', '11111111-9012-1111-1111-111111111111',
   '33333333-9012-1111-1111-111111111111', 'verified', 'Jane Doe', 'HR Manager');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.company_fact_corrections'::regclass),
  'RLS is enabled on company_fact_corrections'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'company_fact_corrections' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on company_fact_corrections'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'company_fact_corrections' and grantee = 'anon'$$,
  'anon has no privileges on company_fact_corrections'
);

set local role service_role;

-- 4. service_role can insert a correction
select lives_ok(
  $$insert into company_fact_corrections (id, employer_claim_id, company_id, field_name, proposed_value)
    values ('dddddddd-9012-1111-1111-111111111111', 'cccccccc-9012-1111-1111-111111111111',
            '33333333-9012-1111-1111-111111111111', 'companies.domain', 'acme-corp.test')$$,
  'service_role can insert into company_fact_corrections'
);

-- 5. service_role cannot insert a correction with an unlisted field_name
select throws_ok(
  $$insert into company_fact_corrections (employer_claim_id, company_id, field_name, proposed_value)
    values ('cccccccc-9012-1111-1111-111111111111', '33333333-9012-1111-1111-111111111111',
            'companies.id', 'not-allowed')$$,
  '23514',
  null,
  'An unlisted field_name violates the check constraint'
);
reset role;

-- as the claimant (Employer A)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9012-1111-1111-111111111111';

-- 6. Employer A can select their own correction (transitive ownership)
select results_eq(
  $$select field_name from company_fact_corrections where id = 'dddddddd-9012-1111-1111-111111111111'$$,
  $$values ('companies.domain'::text)$$,
  'Employer A can select their own correction'
);

-- 7. Employer A cannot insert — no grant exists
select throws_ok(
  $$insert into company_fact_corrections (employer_claim_id, company_id, field_name, proposed_value)
    values ('cccccccc-9012-1111-1111-111111111111', '33333333-9012-1111-1111-111111111111',
            'companies.domain', 'self-approved.test')$$,
  '42501',
  null,
  'Employer A cannot INSERT into company_fact_corrections'
);

-- 8. Employer A cannot update — no grant exists
select throws_ok(
  $$update company_fact_corrections set status = 'approved' where id = 'dddddddd-9012-1111-1111-111111111111'$$,
  '42501',
  null,
  'Employer A cannot UPDATE their own correction'
);

-- 9. Employer A cannot delete — no grant exists
select throws_ok(
  $$delete from company_fact_corrections where id = 'dddddddd-9012-1111-1111-111111111111'$$,
  '42501',
  null,
  'Employer A cannot DELETE their own correction'
);
reset role;

-- as an unrelated candidate
set local role authenticated;
set local request.jwt.claim.sub = '22222222-9012-1111-1111-111111111111';

-- 10. An unrelated candidate cannot see Employer A's correction
select is_empty(
  $$select id from company_fact_corrections where id = 'dddddddd-9012-1111-1111-111111111111'$$,
  'An unrelated candidate cannot see another employer''s correction'
);
reset role;

-- 11. anon cannot select company_fact_corrections
set local role anon;
select throws_ok(
  $$select id from company_fact_corrections$$,
  '42501',
  null,
  'anon cannot SELECT company_fact_corrections — no privilege granted'
);
reset role;

select * from finish();
rollback;
