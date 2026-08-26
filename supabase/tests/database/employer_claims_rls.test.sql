begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-9010-1111-1111-111111111111', 'employer-a@test.local'),
  ('22222222-9010-1111-1111-111111111111', 'employer-b@test.local');

insert into public.companies (id, displayed_name, domain) values
  ('33333333-9010-1111-1111-111111111111', 'Acme Corp', 'acme.test');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.employer_claims'::regclass),
  'RLS is enabled on employer_claims'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'employer_claims' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on employer_claims'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'employer_claims' and grantee = 'anon'$$,
  'anon has no privileges on employer_claims'
);

set local role service_role;

-- 4. service_role can insert an employer claim
select lives_ok(
  $$insert into employer_claims (id, user_id, company_id, representative_name, representative_role)
    values ('dddddddd-9010-1111-1111-111111111111', '11111111-9010-1111-1111-111111111111',
            '33333333-9010-1111-1111-111111111111', 'Jane Doe', 'HR Manager')$$,
  'service_role can insert into employer_claims'
);

-- 5. service_role cannot insert a second claim for the same (user, company) pair
select throws_ok(
  $$insert into employer_claims (user_id, company_id, representative_name, representative_role)
    values ('11111111-9010-1111-1111-111111111111', '33333333-9010-1111-1111-111111111111', 'Jane Doe', 'HR Manager')$$,
  '23505',
  null,
  'A second claim for the same (user_id, company_id) pair violates the unique constraint'
);
reset role;

-- as Candidate/Employer A
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9010-1111-1111-111111111111';

-- 6. Employer A can select their own claim
select results_eq(
  $$select status from employer_claims where id = 'dddddddd-9010-1111-1111-111111111111'$$,
  $$values ('pending'::text)$$,
  'Employer A can select their own claim'
);

-- 7. Employer A cannot insert — no grant exists
select throws_ok(
  $$insert into employer_claims (user_id, company_id, representative_name, representative_role)
    values ('11111111-9010-1111-1111-111111111111', '33333333-9010-1111-1111-111111111111', 'X', 'Y')$$,
  '42501',
  null,
  'Employer A cannot INSERT into employer_claims'
);

-- 8. Employer A cannot update — no grant exists
select throws_ok(
  $$update employer_claims set status = 'verified' where id = 'dddddddd-9010-1111-1111-111111111111'$$,
  '42501',
  null,
  'Employer A cannot UPDATE their own claim'
);

-- 9. Employer A cannot delete — no grant exists
select throws_ok(
  $$delete from employer_claims where id = 'dddddddd-9010-1111-1111-111111111111'$$,
  '42501',
  null,
  'Employer A cannot DELETE their own claim'
);
reset role;

-- as Candidate/Employer B
set local role authenticated;
set local request.jwt.claim.sub = '22222222-9010-1111-1111-111111111111';

-- 10. Employer B cannot see Employer A's claim
select is_empty(
  $$select id from employer_claims where id = 'dddddddd-9010-1111-1111-111111111111'$$,
  'Employer B cannot see Employer A''s claim'
);
reset role;

-- 11. anon cannot select employer_claims
set local role anon;
select throws_ok(
  $$select id from employer_claims$$,
  '42501',
  null,
  'anon cannot SELECT employer_claims — no privilege granted'
);
reset role;

select * from finish();
rollback;
