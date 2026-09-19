begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- Task I. candidate_preferences is a candidate-owned table with row-level
-- security, so the isolation and the closed vocabularies are asserted against
-- the database rather than trusted to the client library.

insert into auth.users (id, email) values
  ('c0c0c0c0-19aa-4000-8000-00000000000a', 'pref-a@test.local'),
  ('c0c0c0c0-19aa-4000-8000-00000000000b', 'pref-b@test.local');

insert into candidate_profiles (id) values
  ('c0c0c0c0-19aa-4000-8000-00000000000a'),
  ('c0c0c0c0-19aa-4000-8000-00000000000b');

-- 1. RLS is on.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.candidate_preferences'::regclass),
  'RLS is enabled on candidate_preferences'
);

-- 2. authenticated holds the four DML privileges the panel needs.
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'candidate_preferences' and grantee = 'authenticated'
  ) = array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  'authenticated has SELECT, INSERT, UPDATE and DELETE on candidate_preferences'
);

-- 3. anon has nothing.
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
     where table_name = 'candidate_preferences' and grantee = 'anon'$$,
  'anon has no privileges on candidate_preferences'
);

-- 4. A candidate can create their own row.
set local role authenticated;
set local request.jwt.claim.sub = 'c0c0c0c0-19aa-4000-8000-00000000000a';

select lives_ok(
  $$insert into candidate_preferences (candidate_id, preferred_countries, remote_preference, min_salary, min_salary_currency)
    values ('c0c0c0c0-19aa-4000-8000-00000000000a', array['India'], 'remote', 80000, 'USD')$$,
  'a candidate can insert their own preferences'
);

-- 5. And read them back.
select results_eq(
  $$select remote_preference from candidate_preferences where candidate_id = 'c0c0c0c0-19aa-4000-8000-00000000000a'$$,
  $$values ('remote'::text)$$,
  'a candidate can read their own preferences'
);

-- 6. But cannot write a row for somebody else.
select throws_ok(
  $$insert into candidate_preferences (candidate_id) values ('c0c0c0c0-19aa-4000-8000-00000000000b')$$,
  '42501',
  null,
  'a candidate cannot insert preferences for another candidate'
);

reset role;

-- 7. Ownership is enforced on read too: B never sees A's row.
set local role authenticated;
set local request.jwt.claim.sub = 'c0c0c0c0-19aa-4000-8000-00000000000b';

select is_empty(
  $$select candidate_id from candidate_preferences where candidate_id = 'c0c0c0c0-19aa-4000-8000-00000000000a'$$,
  'Candidate B cannot read Candidate A''s preferences'
);

select is_empty(
  $$update candidate_preferences set min_salary = 1 where candidate_id = 'c0c0c0c0-19aa-4000-8000-00000000000a' returning candidate_id$$,
  'Candidate B cannot update Candidate A''s preferences'
);

reset role;

-- 8. A salary floor without a currency is refused. 80000 means different things
--    in INR and USD, and defaulting one would silently mis-filter.
select throws_ok(
  $$insert into candidate_preferences (candidate_id, min_salary)
    values ('c0c0c0c0-19aa-4000-8000-00000000000b', 80000)$$,
  '23514',
  null,
  'a minimum salary without a currency is refused'
);

-- 9. The closed vocabularies reject a value the product has no behaviour for.
select throws_ok(
  $$insert into candidate_preferences (candidate_id, remote_preference)
    values ('c0c0c0c0-19aa-4000-8000-00000000000b', 'teleport')$$,
  '23514',
  null,
  'remote_preference rejects a value outside the closed set'
);

select throws_ok(
  $$insert into candidate_preferences (candidate_id, employment_types)
    values ('c0c0c0c0-19aa-4000-8000-00000000000b', array['freelance'])$$,
  '23514',
  null,
  'employment_types rejects a value outside the closed set'
);

-- 10. AND THE TRI-STATE IS REAL: unset, yes and no are three distinct states.
--     Collapsing unset into false would make "I have not said whether I will
--     relocate" indistinguishable from "I will not relocate".
select lives_ok(
  $$insert into candidate_preferences (candidate_id, willing_to_relocate, requires_sponsorship)
    values ('c0c0c0c0-19aa-4000-8000-00000000000b', null, null)$$,
  'an unstated relocation and sponsorship preference is representable as NULL'
);

select * from finish();
rollback;
