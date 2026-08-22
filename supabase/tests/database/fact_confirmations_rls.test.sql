begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- Fixture setup (as postgres, bypasses RLS — not under test; the
-- resume_documents/extracted_facts grants/RLS this fixture also touches
-- are covered in their own *_rls.test.sql files).
insert into auth.users (id, email) values
  ('11111111-9003-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-9003-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-9003-1111-1111-111111111111'),
  ('22222222-9003-1111-1111-111111111111');

insert into resume_documents (id, candidate_id, storage_path, original_filename, mime_type, byte_size)
values (
  'cccccccc-9003-1111-1111-111111111111',
  '11111111-9003-1111-1111-111111111111',
  '11111111-9003-1111-1111-111111111111/resume.pdf',
  'resume.pdf',
  'application/pdf',
  1024
);

insert into extracted_facts (id, candidate_id, source_document_id, fact_type, fact_value, extraction_model, extraction_prompt_version)
values (
  'dddddddd-9003-1111-1111-111111111111',
  '11111111-9003-1111-1111-111111111111',
  'cccccccc-9003-1111-1111-111111111111',
  'years_of_experience',
  '5',
  'test-model',
  'test-prompt-v1'
);

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.fact_confirmations'::regclass),
  'RLS is enabled on fact_confirmations'
);

-- 2. authenticated has exactly SELECT and UPDATE
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'fact_confirmations' and grantee = 'authenticated'
  ) = array['SELECT', 'UPDATE'],
  'authenticated has exactly SELECT and UPDATE on fact_confirmations'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'fact_confirmations' and grantee = 'anon'$$,
  'anon has no privileges on fact_confirmations'
);

set local role service_role;

-- 4. service_role can insert a pending confirmation for the fact
select lives_ok(
  $$insert into fact_confirmations (extracted_fact_id, status)
    values ('dddddddd-9003-1111-1111-111111111111', 'pending')$$,
  'service_role can insert into fact_confirmations'
);

-- 5. an undefined status is rejected by the check constraint
select throws_ok(
  $$update fact_confirmations set status = 'not_a_real_status' where extracted_fact_id = 'dddddddd-9003-1111-1111-111111111111'$$,
  '23514',
  null,
  'An undefined status is rejected by the check constraint'
);
reset role;

-- as Candidate A (owner of the underlying fact)
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9003-1111-1111-111111111111';

-- 6. Candidate A can select their own confirmation
select results_eq(
  $$select status from fact_confirmations where extracted_fact_id = 'dddddddd-9003-1111-1111-111111111111'$$,
  $$values ('pending'::text)$$,
  'Candidate A can select their own fact confirmation'
);

-- 7. Candidate A can confirm their own fact
select lives_ok(
  $$update fact_confirmations set status = 'confirmed' where extracted_fact_id = 'dddddddd-9003-1111-1111-111111111111'$$,
  'Candidate A can update their own fact confirmation'
);
-- 8. status reflects Candidate A's confirmation
select results_eq(
  $$select status from fact_confirmations where extracted_fact_id = 'dddddddd-9003-1111-1111-111111111111'$$,
  $$values ('confirmed'::text)$$,
  'status reflects Candidate A''s confirmation'
);

-- 9. Candidate A cannot insert — no grant exists for authenticated
select throws_ok(
  $$insert into fact_confirmations (extracted_fact_id, status) values ('dddddddd-9003-1111-1111-111111111111', 'pending')$$,
  '42501',
  null,
  'Candidate A cannot INSERT into fact_confirmations'
);

-- 10. Candidate A cannot delete their own confirmation — no grant exists
select throws_ok(
  $$delete from fact_confirmations where extracted_fact_id = 'dddddddd-9003-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot DELETE their own fact confirmation'
);
reset role;

-- as Candidate B (not the owner of the underlying fact)
set local role authenticated;
set local request.jwt.claim.sub = '22222222-9003-1111-1111-111111111111';

-- 11. Candidate B cannot see Candidate A's confirmation
select is_empty(
  $$select extracted_fact_id from fact_confirmations where extracted_fact_id = 'dddddddd-9003-1111-1111-111111111111'$$,
  'Candidate B cannot see Candidate A''s fact confirmation'
);

-- 12. Candidate B's UPDATE against Candidate A's row is filtered by RLS (zero rows, no throw)
select lives_ok(
  $$update fact_confirmations set status = 'rejected' where extracted_fact_id = 'dddddddd-9003-1111-1111-111111111111'$$,
  'UPDATE targeting Candidate A''s confirmation does not throw for Candidate B'
);
reset role;
-- 13. Candidate A's confirmation is unchanged after Candidate B's no-op update attempt
select results_eq(
  $$select status from fact_confirmations where extracted_fact_id = 'dddddddd-9003-1111-1111-111111111111'$$,
  $$values ('confirmed'::text)$$,
  'Candidate A''s confirmation is unchanged after Candidate B''s no-op update attempt'
);

-- 14. anon cannot select fact_confirmations
set local role anon;
select throws_ok(
  $$select extracted_fact_id from fact_confirmations$$,
  '42501',
  null,
  'anon cannot SELECT fact_confirmations — no privilege granted'
);
reset role;

select * from finish();
rollback;
