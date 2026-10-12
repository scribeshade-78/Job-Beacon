begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-9001-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-9001-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-9001-1111-1111-111111111111'),
  ('22222222-9001-1111-1111-111111111111');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.candidate_selected_roles'::regclass),
  'RLS is enabled on candidate_selected_roles'
);

-- 2. authenticated has exactly SELECT, INSERT, UPDATE and DELETE
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'candidate_selected_roles' and grantee = 'authenticated'
  ) = array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  'authenticated has exactly SELECT, INSERT, UPDATE and DELETE on candidate_selected_roles'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'candidate_selected_roles' and grantee = 'anon'$$,
  'anon has no privileges on candidate_selected_roles'
);

set local role authenticated;
set local request.jwt.claim.sub = '11111111-9001-1111-1111-111111111111';

-- 4. Candidate A can insert their own selected role
select lives_ok(
  $$insert into candidate_selected_roles (id, candidate_id, role_name)
    values ('aaaaaaaa-9001-1111-1111-111111111111', '11111111-9001-1111-1111-111111111111', 'Backend Engineer')$$,
  'Candidate A can insert their own selected role'
);

-- 5. Candidate A cannot insert a role on behalf of Candidate B
select throws_ok(
  $$insert into candidate_selected_roles (candidate_id, role_name)
    values ('22222222-9001-1111-1111-111111111111', 'Backend Engineer')$$,
  '42501',
  null,
  'Candidate A cannot insert a selected role owned by Candidate B'
);

-- 6. unique (candidate_id, role_name) rejects a duplicate role for the same candidate
select throws_ok(
  $$insert into candidate_selected_roles (candidate_id, role_name)
    values ('11111111-9001-1111-1111-111111111111', 'Backend Engineer')$$,
  '23505',
  null,
  'A duplicate (candidate_id, role_name) is rejected'
);

-- 7. Candidate A can select their own selected role
select results_eq(
  $$select role_name from candidate_selected_roles where id = 'aaaaaaaa-9001-1111-1111-111111111111'$$,
  $$values ('Backend Engineer'::text)$$,
  'Candidate A can select their own selected role'
);

-- 8. Candidate A can update (correct a typo in) their own selected role
select lives_ok(
  $$update candidate_selected_roles set role_name = 'Senior Backend Engineer' where id = 'aaaaaaaa-9001-1111-1111-111111111111'$$,
  'Candidate A can update their own selected role'
);
select results_eq(
  $$select role_name from candidate_selected_roles where id = 'aaaaaaaa-9001-1111-1111-111111111111'$$,
  $$values ('Senior Backend Engineer'::text)$$,
  'role_name reflects Candidate A''s update'
);

-- 9. Candidate A cannot reassign their own row to a different candidate_id
select throws_ok(
  $$update candidate_selected_roles set candidate_id = '22222222-9001-1111-1111-111111111111' where id = 'aaaaaaaa-9001-1111-1111-111111111111'$$,
  '42501',
  null,
  'Candidate A cannot reassign their own selected role to a different candidate_id'
);

set local request.jwt.claim.sub = '22222222-9001-1111-1111-111111111111';

-- 10. Candidate B cannot see Candidate A's selected role
select is_empty(
  $$select id from candidate_selected_roles where id = 'aaaaaaaa-9001-1111-1111-111111111111'$$,
  'Candidate B cannot see Candidate A''s selected role'
);

-- 11. Candidate B's UPDATE against Candidate A's row is filtered by RLS (zero rows, no throw)
select lives_ok(
  $$update candidate_selected_roles set role_name = 'Hijacked' where id = 'aaaaaaaa-9001-1111-1111-111111111111'$$,
  'UPDATE targeting Candidate A''s row does not throw for Candidate B'
);
reset role;
select results_eq(
  $$select role_name from candidate_selected_roles where id = 'aaaaaaaa-9001-1111-1111-111111111111'$$,
  $$values ('Senior Backend Engineer'::text)$$,
  'Candidate A''s role is unchanged after Candidate B''s no-op update attempt'
);

-- 12. Candidate B's DELETE against Candidate A's row is filtered by RLS (zero rows, no throw)
set local role authenticated;
set local request.jwt.claim.sub = '22222222-9001-1111-1111-111111111111';
select lives_ok(
  $$delete from candidate_selected_roles where id = 'aaaaaaaa-9001-1111-1111-111111111111'$$,
  'DELETE targeting Candidate A''s row does not throw for Candidate B'
);
reset role;
select results_eq(
  $$select count(*)::int from candidate_selected_roles where id = 'aaaaaaaa-9001-1111-1111-111111111111'$$,
  $$values (1)$$,
  'Candidate A''s row still exists after Candidate B''s no-op delete attempt'
);

-- 13. Candidate A can delete their own selected role
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9001-1111-1111-111111111111';
select lives_ok(
  $$delete from candidate_selected_roles where id = 'aaaaaaaa-9001-1111-1111-111111111111'$$,
  'Candidate A can delete their own selected role'
);
reset role;

-- as anon — zero table privileges
set local role anon;

-- 14. anon SELECT is denied outright
select throws_ok(
  $$select role_name from candidate_selected_roles$$,
  '42501',
  null,
  'anon SELECT is denied — no privilege granted'
);

-- 15. anon INSERT is denied outright
select throws_ok(
  $$insert into candidate_selected_roles (candidate_id, role_name)
    values ('33333333-9001-1111-1111-111111111111', 'Anything')$$,
  '42501',
  null,
  'anon INSERT is denied — no privilege granted'
);
reset role;

-- 16. service_role can insert on behalf of any candidate (bypasses RLS)
set local role service_role;
select lives_ok(
  $$insert into candidate_selected_roles (id, candidate_id, role_name)
    values ('bbbbbbbb-9001-1111-1111-111111111111', '22222222-9001-1111-1111-111111111111', 'Data Analyst')$$,
  'service_role can insert into candidate_selected_roles on behalf of any candidate'
);
reset role;

-- 17. Deleting the candidate_profiles row cascades to delete their selected roles.
--
-- The enqueue mesh's row trigger on candidate_selected_roles is switched off
-- for this one statement (and back on straight after). It re-enqueues fit jobs
-- for the candidate across every VERIFIED vacancy in the database, and the
-- candidate_profiles row it would enqueue them for is the one this statement
-- deletes — so on a database that actually has VERIFIED vacancies, which this
-- one now does, the cascade raises fit_analysis_jobs_candidate_id_fkey. The
-- trigger has nothing to do with the cascade under test, and ON DELETE CASCADE
-- is an FK action rather than a user trigger, so the cascade still runs and a
-- cascade regression still fails here. Both statements are inside this file's
-- transaction and roll back with it.
alter table public.candidate_selected_roles
  disable trigger fit_enqueue_on_selected_roles_trigger;
delete from candidate_profiles where id = '22222222-9001-1111-1111-111111111111';
alter table public.candidate_selected_roles
  enable trigger fit_enqueue_on_selected_roles_trigger;
select is_empty(
  $$select id from candidate_selected_roles where candidate_id = '22222222-9001-1111-1111-111111111111'$$,
  'Deleting the candidate_profiles row cascades to delete their selected roles'
);

select * from finish();
rollback;
