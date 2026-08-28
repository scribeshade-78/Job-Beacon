begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- Fixture setup (as postgres, bypasses RLS — not under test; the
-- mailbox_connections/messages grants/RLS this fixture also touches are
-- covered in their own *_rls.test.sql files).
insert into auth.users (id, email) values
  ('11111111-9011-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-9011-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-9011-1111-1111-111111111111'),
  ('22222222-9011-1111-1111-111111111111');

insert into mailbox_connections (id, candidate_id, provider, status)
values ('dddddddd-9011-1111-1111-111111111111', '11111111-9011-1111-1111-111111111111', 'gmail', 'connected');

insert into messages (id, mailbox_connection_id, provider_message_id, subject)
values ('eeeeeeee-9011-1111-1111-111111111111', 'dddddddd-9011-1111-1111-111111111111', 'msg-1', 'Re: your application');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.response_classifications'::regclass),
  'RLS is enabled on response_classifications'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'response_classifications' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on response_classifications'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'response_classifications' and grantee = 'anon'$$,
  'anon has no privileges on response_classifications'
);

set local role service_role;

-- 4. service_role can insert a classification, including the Phase 1 entity columns
select lives_ok(
  $$insert into response_classifications
      (id, message_id, category, confidence, model_version, prompt_version,
       extracted_company, extracted_role, extracted_job_id, extracted_deadline,
       extracted_salary_text, raw_extraction)
    values ('ffffffff-9011-1111-1111-111111111111', 'eeeeeeee-9011-1111-1111-111111111111',
       'rejection', 0.92, 'classifier-v0', 'message-classification-v1',
       'Acme Corp', 'Backend Engineer', 'REQ-42', date '2026-09-15',
       '18-24 LPA', '{"category":"rejection"}'::jsonb)$$,
  'service_role can insert into response_classifications with entity columns'
);

-- 4b. the unique index on message_id makes classification idempotent-by-upsert:
-- a second plain insert for the same message is rejected
select throws_ok(
  $$insert into response_classifications (message_id, category, model_version)
    values ('eeeeeeee-9011-1111-1111-111111111111', 'interview', 'classifier-v0')$$,
  '23505',
  null,
  'a second response_classifications row for the same message violates the unique index'
);
reset role;

-- as Candidate A (owner two joins deep: message -> mailbox_connection)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9011-1111-1111-111111111111';

-- 5. Candidate A can select the classification via the transitive join
select results_eq(
  $$select category from response_classifications where id = 'ffffffff-9011-1111-1111-111111111111'$$,
  $$values ('rejection'::text)$$,
  'Candidate A can select a classification on their own mailbox message'
);

-- 5b. the entity columns are covered by the same SELECT policy — no separate grant needed
select results_eq(
  $$select extracted_company, extracted_job_id, extracted_deadline
      from response_classifications where id = 'ffffffff-9011-1111-1111-111111111111'$$,
  $$values ('Acme Corp'::text, 'REQ-42'::text, date '2026-09-15')$$,
  'Candidate A can read the extracted entity columns on their own message classification'
);

-- 5c. raw_extraction round-trips as jsonb for the owner
select results_eq(
  $$select raw_extraction->>'category' from response_classifications
      where id = 'ffffffff-9011-1111-1111-111111111111'$$,
  $$values ('rejection'::text)$$,
  'Candidate A can read raw_extraction jsonb on their own message classification'
);

-- 6. Candidate A cannot insert — no grant exists
select throws_ok(
  $$insert into response_classifications (message_id, category, model_version)
    values ('eeeeeeee-9011-1111-1111-111111111111', 'fraud', 'classifier-v0')$$,
  '42501',
  null,
  'Candidate A cannot INSERT into response_classifications'
);

-- 7. Candidate A cannot update — no grant exists
select throws_ok(
  $$update response_classifications set category = 'fraud' where id = 'ffffffff-9011-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot UPDATE a classification on their own mailbox message'
);

-- 8. Candidate A cannot delete — no grant exists
select throws_ok(
  $$delete from response_classifications where id = 'ffffffff-9011-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot DELETE a classification on their own mailbox message'
);
reset role;

-- as Candidate B (not the owner)
set local role authenticated;
set local request.jwt.claim.sub = '22222222-9011-1111-1111-111111111111';

-- 9. Candidate B cannot see Candidate A's classification
select is_empty(
  $$select id from response_classifications where id = 'ffffffff-9011-1111-1111-111111111111'$$,
  'Candidate B cannot see a classification on Candidate A''s mailbox message'
);
reset role;

-- 10. anon cannot select response_classifications
set local role anon;
select throws_ok(
  $$select id from response_classifications$$,
  '42501',
  null,
  'anon cannot SELECT response_classifications — no privilege granted'
);
reset role;

-- 11. Deleting the message cascades to delete its classifications
delete from messages where id = 'eeeeeeee-9011-1111-1111-111111111111';
select is_empty(
  $$select id from response_classifications where message_id = 'eeeeeeee-9011-1111-1111-111111111111'$$,
  'Deleting the message cascades to delete its response classifications'
);

select * from finish();
rollback;
