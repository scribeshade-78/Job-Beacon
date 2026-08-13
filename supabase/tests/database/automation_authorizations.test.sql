begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'user-a@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'user-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.automation_authorizations'::regclass),
  'RLS is enabled on automation_authorizations'
);

-- 2. authenticated has exactly SELECT, INSERT and UPDATE, nothing else
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'automation_authorizations' and grantee = 'authenticated'
  ) = array['INSERT', 'SELECT', 'UPDATE'],
  'authenticated has exactly SELECT, INSERT and UPDATE on automation_authorizations'
);

-- 3. anon has no privileges at all on this table
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'automation_authorizations' and grantee = 'anon'$$,
  'anon has no privileges on automation_authorizations'
);

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 4. An undefined status is rejected by the check constraint
select throws_ok(
  $$insert into automation_authorizations (candidate_id, status, consent_version) values ('11111111-1111-1111-1111-111111111111', 'running', 'r1-v1')$$,
  '23514',
  null,
  'An undefined status is rejected by the check constraint'
);

-- 5. User A can give first authorization
select lives_ok(
  $$insert into automation_authorizations (candidate_id, status, consent_version) values ('11111111-1111-1111-1111-111111111111', 'authorized', 'r1-v1')$$,
  'User A can insert their own authorization'
);

-- 6. User A cannot authorize on behalf of User B
select throws_ok(
  $$insert into automation_authorizations (candidate_id, status, consent_version) values ('22222222-2222-2222-2222-222222222222', 'authorized', 'r1-v1')$$,
  '42501',
  null,
  'User A cannot insert an authorization owned by User B'
);

-- 7. User A can pause their own authorization
select lives_ok(
  $$update automation_authorizations set status = 'paused', status_changed_at = now() where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  'User A can pause their own authorization'
);
select results_eq(
  $$select status from automation_authorizations where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  $$values ('paused'::text)$$,
  'Status is paused after User A pauses'
);

-- 8. User A can resume (back to authorized)
select lives_ok(
  $$update automation_authorizations set status = 'authorized', status_changed_at = now() where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  'User A can resume their own authorization'
);

-- 9. User A can stop
select lives_ok(
  $$update automation_authorizations set status = 'stopped', status_changed_at = now() where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  'User A can stop their own authorization'
);

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

-- 10. User B can give their own first authorization
select lives_ok(
  $$insert into automation_authorizations (candidate_id, status, consent_version) values ('22222222-2222-2222-2222-222222222222', 'authorized', 'r1-v1')$$,
  'User B can insert their own authorization'
);

-- 11. User B cannot read User A's authorization
select is_empty(
  $$select status from automation_authorizations where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  'User B cannot read User A authorization'
);

-- 12. User B cannot pause/stop User A's authorization (RLS filters it, zero rows affected)
select lives_ok(
  $$update automation_authorizations set status = 'stopped', status_changed_at = now() where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  'UPDATE targeting User A authorization does not throw for User B'
);
reset role;
select results_eq(
  $$select status from automation_authorizations where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  $$values ('stopped'::text)$$,
  'User A authorization is unchanged (still stopped from their own action) after User B attempted to alter it'
);

-- 13. No DELETE grant exists for authenticated (audit trail is immutable except via status update)
set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select throws_ok(
  $$delete from automation_authorizations where candidate_id = '22222222-2222-2222-2222-222222222222'$$,
  '42501',
  null,
  'DELETE is denied for authenticated — no grant exists for it'
);

-- 14. candidate_id itself cannot be reassigned to another (existing, valid
-- FK target) candidate via UPDATE — run while both A and B rows still
-- exist, isolated from the FK-violation confound of a nonexistent target.
set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select throws_ok(
  $$update automation_authorizations set candidate_id = '22222222-2222-2222-2222-222222222222' where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'User A cannot reassign their own authorization row to a different candidate_id'
);

-- as anon — zero table privileges
reset role;
set local role anon;

-- 15. anon SELECT is denied outright
select throws_ok(
  $$select status from automation_authorizations$$,
  '42501',
  null,
  'anon SELECT is denied — no privilege granted'
);

-- 16. anon INSERT is denied outright
select throws_ok(
  $$insert into automation_authorizations (candidate_id, status, consent_version) values ('33333333-3333-3333-3333-333333333333', 'authorized', 'r1-v1')$$,
  '42501',
  null,
  'anon INSERT is denied — no privilege granted'
);

-- 17. Deleting the candidate_profiles row cascades to delete the authorization row
reset role;
delete from candidate_profiles where id = '22222222-2222-2222-2222-222222222222';
select is_empty(
  $$select candidate_id from automation_authorizations where candidate_id = '22222222-2222-2222-2222-222222222222'$$,
  'Deleting the candidate_profiles row cascades to delete their authorization row'
);

select * from finish();
rollback;
