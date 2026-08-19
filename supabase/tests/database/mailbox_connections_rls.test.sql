begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-9009-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-9009-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-9009-1111-1111-111111111111'),
  ('22222222-9009-1111-1111-111111111111');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.mailbox_connections'::regclass),
  'RLS is enabled on mailbox_connections'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'mailbox_connections' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on mailbox_connections'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'mailbox_connections' and grantee = 'anon'$$,
  'anon has no privileges on mailbox_connections'
);

set local role service_role;

-- 4. service_role can insert a mailbox connection
select lives_ok(
  $$insert into mailbox_connections (id, candidate_id, provider, status)
    values ('dddddddd-9009-1111-1111-111111111111', '11111111-9009-1111-1111-111111111111', 'gmail', 'connected')$$,
  'service_role can insert into mailbox_connections'
);
reset role;

-- as Candidate A
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9009-1111-1111-111111111111';

-- 5. Candidate A can select their own mailbox connection
select results_eq(
  $$select provider from mailbox_connections where id = 'dddddddd-9009-1111-1111-111111111111'$$,
  $$values ('gmail'::text)$$,
  'Candidate A can select their own mailbox connection'
);

-- 6. Candidate A cannot insert — no grant exists
select throws_ok(
  $$insert into mailbox_connections (candidate_id, provider) values ('11111111-9009-1111-1111-111111111111', 'outlook')$$,
  '42501',
  null,
  'Candidate A cannot INSERT into mailbox_connections'
);

-- 7. Candidate A cannot update — no grant exists
select throws_ok(
  $$update mailbox_connections set status = 'revoked' where id = 'dddddddd-9009-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot UPDATE their own mailbox connection'
);

-- 8. Candidate A cannot delete — no grant exists
select throws_ok(
  $$delete from mailbox_connections where id = 'dddddddd-9009-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot DELETE their own mailbox connection'
);
reset role;

-- as Candidate B
set local role authenticated;
set local request.jwt.claim.sub = '22222222-9009-1111-1111-111111111111';

-- 9. Candidate B cannot see Candidate A's mailbox connection
select is_empty(
  $$select id from mailbox_connections where id = 'dddddddd-9009-1111-1111-111111111111'$$,
  'Candidate B cannot see Candidate A''s mailbox connection'
);
reset role;

-- 10. anon cannot select mailbox_connections
set local role anon;
select throws_ok(
  $$select id from mailbox_connections$$,
  '42501',
  null,
  'anon cannot SELECT mailbox_connections — no privilege granted'
);
reset role;

-- 11. Deleting the candidate_profiles row cascades to delete their mailbox connections
delete from candidate_profiles where id = '11111111-9009-1111-1111-111111111111';
select is_empty(
  $$select id from mailbox_connections where candidate_id = '11111111-9009-1111-1111-111111111111'$$,
  'Deleting the candidate_profiles row cascades to delete their mailbox connections'
);

select * from finish();
rollback;
