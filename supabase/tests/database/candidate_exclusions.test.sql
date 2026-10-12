begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'user-a@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'user-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.candidate_exclusions'::regclass),
  'RLS is enabled on candidate_exclusions'
);

-- 2. authenticated has exactly SELECT, INSERT and DELETE, nothing else
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'candidate_exclusions' and grantee = 'authenticated'
  ) = array['DELETE', 'INSERT', 'SELECT'],
  'authenticated has exactly SELECT, INSERT and DELETE on candidate_exclusions'
);

-- 3. anon has no privileges at all on this table
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'candidate_exclusions' and grantee = 'anon'$$,
  'anon has no privileges on candidate_exclusions'
);

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 4. Only the four PRD-named categories are accepted
select throws_ok(
  $$insert into candidate_exclusions (candidate_id, category) values ('11111111-1111-1111-1111-111111111111', 'not_a_real_category')$$,
  '23514',
  null,
  'An undefined category is rejected by the check constraint'
);

-- 5. User A can turn on an exclusion for themselves
select lives_ok(
  $$insert into candidate_exclusions (candidate_id, category) values ('11111111-1111-1111-1111-111111111111', 'staffing_agencies')$$,
  'User A can insert their own exclusion'
);

-- 6. Toggling the same category on twice is rejected (composite PK), not silently duplicated
select throws_ok(
  $$insert into candidate_exclusions (candidate_id, category) values ('11111111-1111-1111-1111-111111111111', 'staffing_agencies')$$,
  '23505',
  null,
  'Duplicate (candidate_id, category) is rejected, not silently duplicated'
);

-- 7. User A can read their own exclusion
select results_eq(
  $$select category from candidate_exclusions where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  $$values ('staffing_agencies'::text)$$,
  'User A can read their own exclusion'
);

-- 8. User A cannot insert an exclusion owned by User B
select throws_ok(
  $$insert into candidate_exclusions (candidate_id, category) values ('22222222-2222-2222-2222-222222222222', 'contract_roles')$$,
  '42501',
  null,
  'User A cannot insert an exclusion owned by User B'
);

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

-- 9. User B can insert their own exclusion
select lives_ok(
  $$insert into candidate_exclusions (candidate_id, category) values ('22222222-2222-2222-2222-222222222222', 'sensitive_sectors')$$,
  'User B can insert their own exclusion'
);

-- 10. User B cannot read User A's exclusion
select is_empty(
  $$select category from candidate_exclusions where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  'User B cannot read User A exclusion'
);

-- 11. User B cannot delete User A's exclusion (RLS filters it, zero rows affected)
select lives_ok(
  $$delete from candidate_exclusions where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  'DELETE targeting User A exclusion does not throw for User B'
);
reset role;
select results_eq(
  $$select category from candidate_exclusions where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  $$values ('staffing_agencies'::text)$$,
  'User A exclusion still exists after User B attempted to delete it'
);

-- 12. User B can turn their own exclusion back off
set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select lives_ok(
  $$delete from candidate_exclusions where candidate_id = '22222222-2222-2222-2222-222222222222' and category = 'sensitive_sectors'$$,
  'User B can delete (toggle off) their own exclusion'
);
select is_empty(
  $$select category from candidate_exclusions where candidate_id = '22222222-2222-2222-2222-222222222222'$$,
  'User B own exclusion is gone after delete'
);

-- as anon — zero table privileges
reset role;
set local role anon;

-- 13. anon SELECT is denied outright
select throws_ok(
  $$select category from candidate_exclusions$$,
  '42501',
  null,
  'anon SELECT is denied — no privilege granted'
);

-- 14. Deleting the candidate_profiles row cascades to delete exclusion rows
reset role;
delete from candidate_profiles where id = '11111111-1111-1111-1111-111111111111';
select is_empty(
  $$select category from candidate_exclusions where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  'Deleting the candidate_profiles row cascades to delete their exclusion rows'
);

select * from finish();
rollback;
