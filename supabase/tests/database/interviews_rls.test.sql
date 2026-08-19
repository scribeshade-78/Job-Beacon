begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Fixture setup (as postgres, bypasses RLS — not under test; the
-- mailbox_connections/messages grants/RLS this fixture also touches are
-- covered in their own *_rls.test.sql files).
insert into auth.users (id, email) values
  ('11111111-9012-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-9012-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-9012-1111-1111-111111111111'),
  ('22222222-9012-1111-1111-111111111111');

insert into mailbox_connections (id, candidate_id, provider, status)
values ('dddddddd-9012-1111-1111-111111111111', '11111111-9012-1111-1111-111111111111', 'gmail', 'connected');

insert into messages (id, mailbox_connection_id, provider_message_id, subject)
values ('eeeeeeee-9012-1111-1111-111111111111', 'dddddddd-9012-1111-1111-111111111111', 'msg-1', 'Interview invite');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.interviews'::regclass),
  'RLS is enabled on interviews'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'interviews' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on interviews'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'interviews' and grantee = 'anon'$$,
  'anon has no privileges on interviews'
);

set local role service_role;

-- 4. service_role can insert an interview
select lives_ok(
  $$insert into interviews (id, message_id, format, scheduled_at)
    values ('ffffffff-9012-1111-1111-111111111111', 'eeeeeeee-9012-1111-1111-111111111111', 'video', now() + interval '3 days')$$,
  'service_role can insert into interviews'
);
reset role;

-- as Candidate A (owner two joins deep: message -> mailbox_connection)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9012-1111-1111-111111111111';

-- 5. Candidate A can select the interview via the transitive join
select results_eq(
  $$select format from interviews where id = 'ffffffff-9012-1111-1111-111111111111'$$,
  $$values ('video'::text)$$,
  'Candidate A can select an interview on their own mailbox message'
);

-- 6. Candidate A cannot insert — no grant exists
select throws_ok(
  $$insert into interviews (message_id, format) values ('eeeeeeee-9012-1111-1111-111111111111', 'phone')$$,
  '42501',
  null,
  'Candidate A cannot INSERT into interviews'
);

-- 7. Candidate A cannot update — no grant exists
select throws_ok(
  $$update interviews set format = 'onsite' where id = 'ffffffff-9012-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot UPDATE an interview on their own mailbox message'
);

-- 8. Candidate A cannot delete — no grant exists
select throws_ok(
  $$delete from interviews where id = 'ffffffff-9012-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot DELETE an interview on their own mailbox message'
);
reset role;

-- as Candidate B (not the owner)
set local role authenticated;
set local request.jwt.claim.sub = '22222222-9012-1111-1111-111111111111';

-- 9. Candidate B cannot see Candidate A's interview
select is_empty(
  $$select id from interviews where id = 'ffffffff-9012-1111-1111-111111111111'$$,
  'Candidate B cannot see an interview on Candidate A''s mailbox message'
);
reset role;

-- 10. anon cannot select interviews
set local role anon;
select throws_ok(
  $$select id from interviews$$,
  '42501',
  null,
  'anon cannot SELECT interviews — no privilege granted'
);
reset role;

-- 11. Deleting the message cascades to delete its interviews
delete from messages where id = 'eeeeeeee-9012-1111-1111-111111111111';
select is_empty(
  $$select id from interviews where message_id = 'eeeeeeee-9012-1111-1111-111111111111'$$,
  'Deleting the message cascades to delete its interviews'
);

select * from finish();
rollback;
