begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-9011-1111-1111-111111111111', 'employer-a@test.local'),
  ('22222222-9011-1111-1111-111111111111', 'candidate-b@test.local'),
  ('44444444-9011-1111-1111-111111111111', 'moderator@test.local');

insert into public.companies (id, displayed_name, domain) values
  ('33333333-9011-1111-1111-111111111111', 'Acme Corp', 'acme.test');

insert into public.employer_claims (id, user_id, company_id, representative_name, representative_role) values
  ('dddddddd-9011-1111-1111-111111111111', '11111111-9011-1111-1111-111111111111',
   '33333333-9011-1111-1111-111111111111', 'Jane Doe', 'HR Manager');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.employer_claim_decisions'::regclass),
  'RLS is enabled on employer_claim_decisions'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'employer_claim_decisions' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on employer_claim_decisions'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'employer_claim_decisions' and grantee = 'anon'$$,
  'anon has no privileges on employer_claim_decisions'
);

set local role service_role;

-- 4. service_role can insert a decision
select lives_ok(
  $$insert into employer_claim_decisions (id, employer_claim_id, reviewer_id, decision, rationale)
    values ('eeeeeeee-9011-1111-1111-111111111111', 'dddddddd-9011-1111-1111-111111111111',
            '44444444-9011-1111-1111-111111111111', 'rejected', 'Domain did not match, and no other evidence provided.')$$,
  'service_role can insert into employer_claim_decisions'
);
reset role;

-- as the claimant (Employer A)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9011-1111-1111-111111111111';

-- 5. The claimant can select the decision on their own claim (transitive ownership)
select results_eq(
  $$select decision from employer_claim_decisions where id = 'eeeeeeee-9011-1111-1111-111111111111'$$,
  $$values ('rejected'::text)$$,
  'The claimant can select the decision on their own claim'
);

-- 6. The claimant cannot insert — no grant exists
select throws_ok(
  $$insert into employer_claim_decisions (employer_claim_id, reviewer_id, decision, rationale)
    values ('dddddddd-9011-1111-1111-111111111111', '11111111-9011-1111-1111-111111111111', 'verified', 'self-approved')$$,
  '42501',
  null,
  'The claimant cannot INSERT into employer_claim_decisions'
);

-- 7. The claimant cannot update — no grant exists
select throws_ok(
  $$update employer_claim_decisions set decision = 'verified' where id = 'eeeeeeee-9011-1111-1111-111111111111'$$,
  '42501',
  null,
  'The claimant cannot UPDATE a decision'
);

-- 8. The claimant cannot delete — no grant exists
select throws_ok(
  $$delete from employer_claim_decisions where id = 'eeeeeeee-9011-1111-1111-111111111111'$$,
  '42501',
  null,
  'The claimant cannot DELETE a decision'
);
reset role;

-- as an unrelated candidate
set local role authenticated;
set local request.jwt.claim.sub = '22222222-9011-1111-1111-111111111111';

-- 9. An unrelated candidate cannot see the decision
select is_empty(
  $$select id from employer_claim_decisions where id = 'eeeeeeee-9011-1111-1111-111111111111'$$,
  'An unrelated candidate cannot see another claim''s decision'
);
reset role;

-- 10. anon cannot select employer_claim_decisions
set local role anon;
select throws_ok(
  $$select id from employer_claim_decisions$$,
  '42501',
  null,
  'anon cannot SELECT employer_claim_decisions — no privilege granted'
);
reset role;

-- 11. Deleting the employer_claims row cascades to delete its decisions
delete from public.employer_claims where id = 'dddddddd-9011-1111-1111-111111111111';
select is_empty(
  $$select id from employer_claim_decisions where employer_claim_id = 'dddddddd-9011-1111-1111-111111111111'$$,
  'Deleting the employer_claims row cascades to delete its decisions'
);

select * from finish();
rollback;
