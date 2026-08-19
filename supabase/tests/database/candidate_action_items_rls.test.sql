begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Fixture setup (as postgres, bypasses RLS — not under test; the
-- mailbox_connections/messages grants/RLS this fixture also touches are
-- covered in their own *_rls.test.sql files).
insert into auth.users (id, email) values
  ('11111111-9013-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-9013-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-9013-1111-1111-111111111111'),
  ('22222222-9013-1111-1111-111111111111');

insert into mailbox_connections (id, candidate_id, provider, status)
values ('dddddddd-9013-1111-1111-111111111111', '11111111-9013-1111-1111-111111111111', 'gmail', 'connected');

insert into messages (id, mailbox_connection_id, provider_message_id, subject)
values ('eeeeeeee-9013-1111-1111-111111111111', 'dddddddd-9013-1111-1111-111111111111', 'msg-1', 'Please confirm your interview slot');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.candidate_action_items'::regclass),
  'RLS is enabled on candidate_action_items'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'candidate_action_items' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on candidate_action_items'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'candidate_action_items' and grantee = 'anon'$$,
  'anon has no privileges on candidate_action_items'
);

set local role service_role;

-- 4. service_role can insert an action item
select lives_ok(
  $$insert into candidate_action_items (id, message_id, item_type, status)
    values ('ffffffff-9013-1111-1111-111111111111', 'eeeeeeee-9013-1111-1111-111111111111', 'confirm_interview_slot', 'pending')$$,
  'service_role can insert into candidate_action_items'
);
reset role;

-- as Candidate A (owner two joins deep: message -> mailbox_connection)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9013-1111-1111-111111111111';

-- 5. Candidate A can select the action item via the transitive join
select results_eq(
  $$select item_type from candidate_action_items where id = 'ffffffff-9013-1111-1111-111111111111'$$,
  $$values ('confirm_interview_slot'::text)$$,
  'Candidate A can select an action item on their own mailbox message'
);

-- 6. Candidate A cannot insert — no grant exists
select throws_ok(
  $$insert into candidate_action_items (message_id, item_type)
    values ('eeeeeeee-9013-1111-1111-111111111111', 'fraud')$$,
  '42501',
  null,
  'Candidate A cannot INSERT into candidate_action_items'
);

-- 7. Candidate A cannot update — no grant exists
select throws_ok(
  $$update candidate_action_items set status = 'completed' where id = 'ffffffff-9013-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot UPDATE an action item on their own mailbox message'
);

-- 8. Candidate A cannot delete — no grant exists
select throws_ok(
  $$delete from candidate_action_items where id = 'ffffffff-9013-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot DELETE an action item on their own mailbox message'
);
reset role;

-- as Candidate B (not the owner)
set local role authenticated;
set local request.jwt.claim.sub = '22222222-9013-1111-1111-111111111111';

-- 9. Candidate B cannot see Candidate A's action item
select is_empty(
  $$select id from candidate_action_items where id = 'ffffffff-9013-1111-1111-111111111111'$$,
  'Candidate B cannot see an action item on Candidate A''s mailbox message'
);
reset role;

-- 10. anon cannot select candidate_action_items
set local role anon;
select throws_ok(
  $$select id from candidate_action_items$$,
  '42501',
  null,
  'anon cannot SELECT candidate_action_items — no privilege granted'
);
reset role;

-- 11. Deleting the message cascades to delete its action items
delete from messages where id = 'eeeeeeee-9013-1111-1111-111111111111';
select is_empty(
  $$select id from candidate_action_items where message_id = 'eeeeeeee-9013-1111-1111-111111111111'$$,
  'Deleting the message cascades to delete its action items'
);

select * from finish();
rollback;
