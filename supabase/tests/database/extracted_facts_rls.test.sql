begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-9002-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-9002-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-9002-1111-1111-111111111111'),
  ('22222222-9002-1111-1111-111111111111');

insert into resume_documents (id, candidate_id, storage_path, original_filename, mime_type, byte_size)
values (
  'cccccccc-9002-1111-1111-111111111111',
  '11111111-9002-1111-1111-111111111111',
  '11111111-9002-1111-1111-111111111111/resume.pdf',
  'resume.pdf',
  'application/pdf',
  1024
);

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.extracted_facts'::regclass),
  'RLS is enabled on extracted_facts'
);

-- 2. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'extracted_facts' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on extracted_facts'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'extracted_facts' and grantee = 'anon'$$,
  'anon has no privileges on extracted_facts'
);

set local role service_role;

-- 4. service_role can insert an extracted fact
select lives_ok(
  $$insert into extracted_facts (id, candidate_id, source_document_id, fact_type, fact_value)
    values ('dddddddd-9002-1111-1111-111111111111', '11111111-9002-1111-1111-111111111111', 'cccccccc-9002-1111-1111-111111111111', 'years_of_experience', '5')$$,
  'service_role can insert into extracted_facts'
);
reset role;

-- as Candidate A
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9002-1111-1111-111111111111';

-- 5. Candidate A can select their own fact
select results_eq(
  $$select fact_value from extracted_facts where id = 'dddddddd-9002-1111-1111-111111111111'$$,
  $$values ('5'::text)$$,
  'Candidate A can select their own extracted fact'
);

-- 6. Candidate A cannot insert — no grant exists for authenticated
select throws_ok(
  $$insert into extracted_facts (candidate_id, source_document_id, fact_type, fact_value)
    values ('11111111-9002-1111-1111-111111111111', 'cccccccc-9002-1111-1111-111111111111', 'years_of_experience', '7')$$,
  '42501',
  null,
  'Candidate A cannot INSERT into extracted_facts'
);

-- 7. Candidate A cannot update their own fact — no grant exists
select throws_ok(
  $$update extracted_facts set fact_value = '10' where id = 'dddddddd-9002-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot UPDATE their own extracted fact'
);

-- 8. Candidate A cannot delete their own fact — no grant exists
select throws_ok(
  $$delete from extracted_facts where id = 'dddddddd-9002-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot DELETE their own extracted fact'
);
reset role;

-- as Candidate B
set local role authenticated;
set local request.jwt.claim.sub = '22222222-9002-1111-1111-111111111111';

-- 9. Candidate B cannot see Candidate A's fact
select is_empty(
  $$select id from extracted_facts where id = 'dddddddd-9002-1111-1111-111111111111'$$,
  'Candidate B cannot see Candidate A''s extracted fact'
);
reset role;

-- 10. anon cannot select extracted_facts
set local role anon;
select throws_ok(
  $$select id from extracted_facts$$,
  '42501',
  null,
  'anon cannot SELECT extracted_facts — no privilege granted'
);
reset role;

-- 11. Deleting the candidate_profiles row cascades to delete their extracted facts
delete from candidate_profiles where id = '11111111-9002-1111-1111-111111111111';
select is_empty(
  $$select id from extracted_facts where candidate_id = '11111111-9002-1111-1111-111111111111'$$,
  'Deleting the candidate_profiles row cascades to delete their extracted facts'
);

select * from finish();
rollback;
