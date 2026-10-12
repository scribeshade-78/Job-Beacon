begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'user-a@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'user-b@test.local');

-- candidate_profiles rows are the FK target for resume_documents.candidate_id;
-- inserted here as postgres (bypasses RLS) purely as test fixture setup, not
-- something under test — MP2A's own suite already covers that table's RLS.
insert into candidate_profiles (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.resume_documents'::regclass),
  'RLS is enabled on resume_documents'
);

-- 2a. authenticated holds exactly SELECT and DELETE at TABLE level.
-- 20260929120000_resume_parse_status.sql revoked the table-wide INSERT and
-- re-granted it per column, so a candidate cannot forge parse_status (or any
-- other service-role-written column). UPDATE stays absent entirely.
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'resume_documents' and grantee = 'authenticated'
  ) = array['DELETE', 'SELECT'],
  'authenticated has exactly SELECT and DELETE at table level on resume_documents'
);

-- 2b. INSERT survives only as a column-scoped grant on the five upload columns.
select ok(
  (
    select array_agg(column_name::text order by column_name)
    from information_schema.column_privileges
    where table_name = 'resume_documents'
      and grantee = 'authenticated'
      and privilege_type = 'INSERT'
  ) = array['byte_size', 'candidate_id', 'mime_type', 'original_filename', 'storage_path'],
  'authenticated INSERT on resume_documents is column-scoped to exactly the five upload columns'
);

-- 3. anon has no privileges at all on this table
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'resume_documents' and grantee = 'anon'$$,
  'anon has no privileges on resume_documents'
);

-- as User A
set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 4. User A can insert their own resume row
select lives_ok(
  $$insert into resume_documents (candidate_id, storage_path, original_filename, mime_type, byte_size)
    values ('11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111/resume.pdf', 'resume.pdf', 'application/pdf', 1024)$$,
  'User A can insert their own resume row'
);

-- 5. User A can select their own row
select results_eq(
  $$select candidate_id from resume_documents where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  $$values ('11111111-1111-1111-1111-111111111111'::uuid)$$,
  'User A can select their own resume row'
);

-- 6. User A cannot insert a row owned by User B — RLS WITH CHECK rejects it
select throws_ok(
  $$insert into resume_documents (candidate_id, storage_path, original_filename, mime_type, byte_size)
    values ('22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222/resume.pdf', 'resume.pdf', 'application/pdf', 1024)$$,
  '42501',
  null,
  'User A cannot insert a resume row owned by User B'
);

-- as User B
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

-- 7. User B can insert their own row
select lives_ok(
  $$insert into resume_documents (candidate_id, storage_path, original_filename, mime_type, byte_size)
    values ('22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222/resume.pdf', 'resume.pdf', 'application/pdf', 2048)$$,
  'User B can insert their own resume row'
);

-- 8. User B cannot read User A's row
select is_empty(
  $$select candidate_id from resume_documents where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  'User B cannot read User A resume row'
);

-- back to User A
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 9. User A cannot read User B's row
select is_empty(
  $$select candidate_id from resume_documents where candidate_id = '22222222-2222-2222-2222-222222222222'$$,
  'User A cannot read User B resume row'
);

-- 10. UPDATE is denied for authenticated — no grant or policy exists for it
select throws_ok(
  $$update resume_documents set original_filename = original_filename where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  '42501',
  null,
  'UPDATE is denied for authenticated — no grant or policy exists for it'
);

-- 11. User A cannot delete User B's row — RLS USING filters it, so this is
-- zero rows affected, not a permission error (User A does have DELETE grant).
select lives_ok(
  $$delete from resume_documents where candidate_id = '22222222-2222-2222-2222-222222222222'$$,
  'DELETE targeting User B row does not throw for User A'
);
-- Verified as postgres (bypasses RLS), not as User A: User A's own SELECT
-- policy would hide User B's row regardless of whether it was deleted, so
-- checking "still exists" from A's session can't tell delete-blocked apart
-- from delete-succeeded-but-hidden. Ground truth requires bypassing RLS.
reset role;
select results_eq(
  $$select candidate_id from resume_documents where candidate_id = '22222222-2222-2222-2222-222222222222'$$,
  $$values ('22222222-2222-2222-2222-222222222222'::uuid)$$,
  'User B row still exists after User A attempted to delete it'
);
set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 12. User A can delete their own row
select lives_ok(
  $$delete from resume_documents where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  'User A can delete their own resume row'
);
select is_empty(
  $$select candidate_id from resume_documents where candidate_id = '11111111-1111-1111-1111-111111111111'$$,
  'User A own row is gone after delete'
);

-- as anon — zero table privileges, so every attempt fails at the grant
-- check itself (permission denied), before RLS is even evaluated.
reset role;
set local role anon;

-- 13. anon SELECT is denied outright
select throws_ok(
  $$select candidate_id from resume_documents$$,
  '42501',
  null,
  'anon SELECT is denied — no privilege granted'
);

-- 14. anon INSERT is denied outright
select throws_ok(
  $$insert into resume_documents (candidate_id, storage_path, original_filename, mime_type, byte_size)
    values ('33333333-3333-3333-3333-333333333333', 'x/resume.pdf', 'resume.pdf', 'application/pdf', 1)$$,
  '42501',
  null,
  'anon INSERT is denied — no privilege granted'
);

-- 15. Deleting the candidate_profiles row cascades to delete the resume row
reset role;
select lives_ok(
  $$insert into resume_documents (candidate_id, storage_path, original_filename, mime_type, byte_size)
    values ('22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222/cascade-check.pdf', 'cascade-check.pdf', 'application/pdf', 512)$$,
  'Fixture insert for cascade test'
);
delete from candidate_profiles where id = '22222222-2222-2222-2222-222222222222';
select is_empty(
  $$select id from resume_documents where candidate_id = '22222222-2222-2222-2222-222222222222'$$,
  'Deleting the candidate_profiles row cascades to delete their resume_documents rows'
);

-- storage.objects RLS: candidate-owned folder scoping. Grants on
-- storage.objects are Supabase's own platform default (broad, RLS-enforced)
-- and are intentionally left untouched by this migration — only the
-- policies restricting access to the caller's own folder are under test.
set local storage.allow_delete_query = 'true';

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 16. User A can insert an object into their own folder in the resumes bucket
select lives_ok(
  $$insert into storage.objects (bucket_id, name) values ('resumes', '11111111-1111-1111-1111-111111111111/resume.pdf')$$,
  'User A can insert a storage object into their own folder'
);

-- 17. User A cannot insert an object into User B's folder
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('resumes', '22222222-2222-2222-2222-222222222222/resume.pdf')$$,
  '42501',
  null,
  'User A cannot insert a storage object into User B folder'
);

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

-- 18. User B cannot read the object in User A's folder
select is_empty(
  $$select name from storage.objects where bucket_id = 'resumes' and name = '11111111-1111-1111-1111-111111111111/resume.pdf'$$,
  'User B cannot read an object in User A folder'
);

-- 19. User B cannot delete the object in User A's folder
select lives_ok(
  $$delete from storage.objects where bucket_id = 'resumes' and name = '11111111-1111-1111-1111-111111111111/resume.pdf'$$,
  'DELETE targeting User A object does not throw for User B'
);
-- Verified as postgres (bypasses RLS) for the same reason as the
-- resume_documents check above: User B's own SELECT policy would hide
-- User A's object regardless of whether the delete succeeded.
reset role;
select results_eq(
  $$select name from storage.objects where bucket_id = 'resumes' and name = '11111111-1111-1111-1111-111111111111/resume.pdf'$$,
  $$values ('11111111-1111-1111-1111-111111111111/resume.pdf'::text)$$,
  'User A object still exists after User B attempted to delete it'
);

-- 20. User A can delete their own object
set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select lives_ok(
  $$delete from storage.objects where bucket_id = 'resumes' and name = '11111111-1111-1111-1111-111111111111/resume.pdf'$$,
  'User A can delete their own storage object'
);

select * from finish();
rollback;
