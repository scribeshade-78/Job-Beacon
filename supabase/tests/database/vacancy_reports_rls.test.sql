begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-6666-1111-1111-111111111111', 'reporter-a@test.local'),
  ('22222222-6666-1111-1111-111111111111', 'reporter-b@test.local'),
  ('33333333-6666-1111-1111-111111111111', 'moderator-c@test.local');

insert into user_roles (user_id, role) values
  ('33333333-6666-1111-1111-111111111111', 'moderator');

insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('greenhouse', 'none', 'r2-v1', array['US']);

insert into companies (id, displayed_name, domain)
values ('cccccccc-6666-1111-1111-111111111111', 'Reportco', 'reportco.example');

insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-6666-1111-1111-111111111111', 'greenhouse', 'reportco');

insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
values ('eeeeeeee-6666-1111-1111-111111111111', 'greenhouse', 'dddddddd-6666-1111-1111-111111111111', 'job-report-1', 'https://reportco.example/jobs/1', 'Report Test Role', 'cccccccc-6666-1111-1111-111111111111');

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vacancy_reports'::regclass),
  'RLS is enabled on vacancy_reports'
);

-- 2. authenticated has exactly SELECT and INSERT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'vacancy_reports' and grantee = 'authenticated'
  ) = array['INSERT', 'SELECT'],
  'authenticated has exactly SELECT and INSERT on vacancy_reports'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'vacancy_reports' and grantee = 'anon'$$,
  'anon has no privileges on vacancy_reports'
);

-- as Reporter A
set local role authenticated;
set local request.jwt.claim.sub = '11111111-6666-1111-1111-111111111111';

-- 4. Reporter A can insert their own report
select lives_ok(
  $$insert into vacancy_reports (id, vacancy_id, reporter_id, category, description)
    values ('ffffffff-6666-1111-1111-111111111111', 'eeeeeeee-6666-1111-1111-111111111111', '11111111-6666-1111-1111-111111111111', 'payment_request', 'Asked me to pay a $50 registration fee.')$$,
  'Reporter A can insert their own report'
);

-- 5. Reporter A can select their own report
select results_eq(
  $$select category from vacancy_reports where id = 'ffffffff-6666-1111-1111-111111111111'$$,
  $$values ('payment_request'::text)$$,
  'Reporter A can select their own report'
);

-- 6. Reporter A cannot insert a report attributed to someone else
select throws_ok(
  $$insert into vacancy_reports (vacancy_id, reporter_id, category)
    values ('eeeeeeee-6666-1111-1111-111111111111', '22222222-6666-1111-1111-111111111111', 'fake_job')$$,
  '42501',
  null,
  'Reporter A cannot insert a report attributed to a different reporter_id'
);

-- 7. Reporter A cannot UPDATE their own report — no grant/policy exists for it
select throws_ok(
  $$update vacancy_reports set description = 'edited' where id = 'ffffffff-6666-1111-1111-111111111111'$$,
  '42501',
  null,
  'Reporter A cannot UPDATE their own report'
);

-- 8. Reporter A cannot DELETE their own report
select throws_ok(
  $$delete from vacancy_reports where id = 'ffffffff-6666-1111-1111-111111111111'$$,
  '42501',
  null,
  'Reporter A cannot DELETE their own report'
);
reset role;

-- as Reporter B
set local role authenticated;
set local request.jwt.claim.sub = '22222222-6666-1111-1111-111111111111';

-- 9. Reporter B cannot see Reporter A's report
select is_empty(
  $$select category from vacancy_reports where id = 'ffffffff-6666-1111-1111-111111111111'$$,
  'Reporter B cannot see Reporter A''s report'
);
reset role;

-- as the moderator
set local role authenticated;
set local request.jwt.claim.sub = '33333333-6666-1111-1111-111111111111';

-- 10. moderator can see Reporter A's report
select results_eq(
  $$select category from vacancy_reports where id = 'ffffffff-6666-1111-1111-111111111111'$$,
  $$values ('payment_request'::text)$$,
  'moderator can see any candidate''s report'
);
reset role;

-- 11. anon cannot select vacancy_reports
set local role anon;
select throws_ok(
  $$select category from vacancy_reports$$,
  '42501',
  null,
  'anon cannot SELECT vacancy_reports — no privilege granted'
);
reset role;

-- 12. an invalid category value is rejected by the check constraint
set local role authenticated;
set local request.jwt.claim.sub = '11111111-6666-1111-1111-111111111111';
select throws_ok(
  $$insert into vacancy_reports (vacancy_id, reporter_id, category)
    values ('eeeeeeee-6666-1111-1111-111111111111', '11111111-6666-1111-1111-111111111111', 'not_a_real_category')$$,
  '23514',
  null,
  'an invalid vacancy_reports.category value is rejected by the check constraint'
);
reset role;

select * from finish();
rollback;
