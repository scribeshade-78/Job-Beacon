begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

-- Fixture setup (as postgres, bypasses RLS — not under test; the
-- mailbox_connections grants/RLS this fixture also touches are covered
-- in its own *_rls.test.sql file).
insert into auth.users (id, email) values
  ('11111111-9010-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-9010-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-9010-1111-1111-111111111111'),
  ('22222222-9010-1111-1111-111111111111');

insert into mailbox_connections (id, candidate_id, provider, status)
values ('dddddddd-9010-1111-1111-111111111111', '11111111-9010-1111-1111-111111111111', 'gmail', 'connected');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.messages'::regclass),
  'RLS is enabled on messages'
);

-- 2. authenticated has exactly SELECT
-- table_schema filter matters here specifically: Supabase's own
-- realtime.messages table (an internal Realtime feature table,
-- unrelated to this migration) also happens to be named "messages" and
-- grants broad privileges to anon/authenticated by default — without
-- this filter, information_schema.role_table_grants conflates the two
-- same-named tables from different schemas.
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'messages' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on public.messages'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'messages' and grantee = 'anon'$$,
  'anon has no privileges on public.messages'
);

set local role service_role;

-- 4. service_role can insert a message
select lives_ok(
  $$insert into messages (id, mailbox_connection_id, provider_message_id, sender, subject)
    values ('eeeeeeee-9010-1111-1111-111111111111', 'dddddddd-9010-1111-1111-111111111111', 'msg-1', 'recruiter@applyco.example', 'Re: your application')$$,
  'service_role can insert into messages'
);

-- 4b. service_role can record an application-match result (Phase 3).
-- application_attempt_id is left NULL here — pointing it at a real attempt
-- needs the whole application_plans -> vacancies -> ... fixture chain,
-- which application_attempts_rls.test.sql already covers; this asserts the
-- new explainability column is writable and the matcher's shape round-trips.
select lives_ok(
  $$update messages
      set application_match =
        '{"confidence": 0.95, "reasons": ["job_id_exact"], "matched_at": "2026-08-28T00:00:00Z"}'::jsonb
    where id = 'eeeeeeee-9010-1111-1111-111111111111'$$,
  'service_role can write messages.application_match'
);

-- 5. a duplicate (mailbox_connection_id, provider_message_id) is rejected
select throws_ok(
  $$insert into messages (mailbox_connection_id, provider_message_id)
    values ('dddddddd-9010-1111-1111-111111111111', 'msg-1')$$,
  '23505',
  null,
  'A duplicate (mailbox_connection_id, provider_message_id) is rejected'
);
reset role;

-- as Candidate A (owner of the underlying mailbox connection)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9010-1111-1111-111111111111';

-- 6. Candidate A can select the message via the join to their own mailbox connection
select results_eq(
  $$select subject from messages where id = 'eeeeeeee-9010-1111-1111-111111111111'$$,
  $$values ('Re: your application'::text)$$,
  'Candidate A can select a message on their own mailbox connection'
);

-- 6b. the application_match explainability column is covered by the same
-- SELECT policy — no separate grant, the owner can read why it was linked
select results_eq(
  $$select application_match->>'confidence' from messages
      where id = 'eeeeeeee-9010-1111-1111-111111111111'$$,
  $$values ('0.95'::text)$$,
  'Candidate A can read messages.application_match on their own message'
);

-- 7. Candidate A cannot insert — no grant exists
select throws_ok(
  $$insert into messages (mailbox_connection_id, provider_message_id)
    values ('dddddddd-9010-1111-1111-111111111111', 'msg-2')$$,
  '42501',
  null,
  'Candidate A cannot INSERT into messages'
);

-- 8. Candidate A cannot update — no grant exists
select throws_ok(
  $$update messages set subject = 'Fraud' where id = 'eeeeeeee-9010-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot UPDATE a message on their own mailbox connection'
);

-- 9. Candidate A cannot delete — no grant exists
select throws_ok(
  $$delete from messages where id = 'eeeeeeee-9010-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot DELETE a message on their own mailbox connection'
);
reset role;

-- as Candidate B (not the owner of the underlying mailbox connection)
set local role authenticated;
set local request.jwt.claim.sub = '22222222-9010-1111-1111-111111111111';

-- 10. Candidate B cannot see Candidate A's message
select is_empty(
  $$select id from messages where id = 'eeeeeeee-9010-1111-1111-111111111111'$$,
  'Candidate B cannot see a message on Candidate A''s mailbox connection'
);
reset role;

-- 11. anon cannot select messages
set local role anon;
select throws_ok(
  $$select id from messages$$,
  '42501',
  null,
  'anon cannot SELECT messages — no privilege granted'
);
reset role;

select * from finish();
rollback;
