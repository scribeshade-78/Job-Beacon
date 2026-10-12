begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- Test fixtures: minimal auth.users rows. Verified directly against the
-- local Postgres schema (not assumed) that only `id` is NOT NULL besides
-- boolean columns with defaults — a 2-column insert is schema-valid, and
-- auth.uid() reads only the session-local `request.jwt.claim.sub` setting
-- (confirmed via pg_get_functiondef), independent of auth.users content.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'user-a@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'user-b@test.local');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.candidate_profiles'::regclass),
  'RLS is enabled on candidate_profiles'
);

-- 2. authenticated has exactly SELECT and INSERT, nothing else
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'candidate_profiles' and grantee = 'authenticated'
  ) = array['INSERT', 'SELECT'],
  'authenticated has exactly SELECT and INSERT on candidate_profiles'
);

-- 3. anon has no privileges at all on this table
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'candidate_profiles' and grantee = 'anon'$$,
  'anon has no privileges on candidate_profiles'
);

-- as User A
set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 4. User A can insert their own row
select lives_ok(
  $$insert into candidate_profiles (id) values ('11111111-1111-1111-1111-111111111111')$$,
  'User A can insert their own row'
);

-- 5. User A can select their own row
select results_eq(
  $$select id from candidate_profiles where id = '11111111-1111-1111-1111-111111111111'$$,
  $$values ('11111111-1111-1111-1111-111111111111'::uuid)$$,
  'User A can select their own row'
);

-- 6. User A cannot insert a row owned by User B — RLS WITH CHECK rejects it
select throws_ok(
  $$insert into candidate_profiles (id) values ('22222222-2222-2222-2222-222222222222')$$,
  '42501',
  null,
  'User A cannot insert a row owned by User B'
);

-- as User B
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

-- 7. User B can insert their own row (also sets up the isolation tests below)
select lives_ok(
  $$insert into candidate_profiles (id) values ('22222222-2222-2222-2222-222222222222')$$,
  'User B can insert their own row'
);

-- 8. User B cannot read User A's row — both have SELECT grant, so this is
-- RLS silently filtering the row, not a permission error. Zero rows, not a throw.
select is_empty(
  $$select id from candidate_profiles where id = '11111111-1111-1111-1111-111111111111'$$,
  'User B cannot read User A row'
);

-- back to User A
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 9. User A cannot read User B's row — same reasoning as above
select is_empty(
  $$select id from candidate_profiles where id = '22222222-2222-2222-2222-222222222222'$$,
  'User A cannot read User B row'
);

-- 10. UPDATE is denied for authenticated — no grant and no policy exist for it
select throws_ok(
  $$update candidate_profiles set id = id where id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'UPDATE is denied for authenticated — no grant or policy exists for it'
);

-- 11. DELETE is denied for authenticated — no grant and no policy exist for it
select throws_ok(
  $$delete from candidate_profiles where id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'DELETE is denied for authenticated — no grant or policy exists for it'
);

-- as anon — zero table privileges, so every attempt fails at the grant
-- check itself (permission denied), before RLS is even evaluated.
reset role;
set local role anon;

-- 12. anon SELECT is denied outright
select throws_ok(
  $$select id from candidate_profiles$$,
  '42501',
  null,
  'anon SELECT is denied — no privilege granted'
);

-- 13. anon INSERT is denied outright
select throws_ok(
  $$insert into candidate_profiles (id) values ('33333333-3333-3333-3333-333333333333')$$,
  '42501',
  null,
  'anon INSERT is denied — no privilege granted'
);

-- 14. Deleting the auth.users row cascades to delete the owned profile row
reset role;
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is_empty(
  $$select id from candidate_profiles where id = '11111111-1111-1111-1111-111111111111'$$,
  'Deleting the auth user cascades to delete their candidate_profiles row'
);

select * from finish();
rollback;
