-- Opportunity Intelligence Phase 2.3b — the stored priority score columns
-- on fit_analyses. Covers the two things the migration relies on without
-- restating them: that the pre-existing table-level `grant select ... to
-- authenticated` really does extend to columns added later (so the owning
-- candidate can read their score with no grant change), and that the
-- 0-100 check constraints actually fire.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Fixture (as postgres).
insert into auth.users (id, email) values
  ('aaaaaaaa-9231-1111-1111-111111111111', 'prio-a@test.local'),
  ('bbbbbbbb-9231-1111-1111-111111111111', 'prio-b@test.local');
insert into candidate_profiles (id) values
  ('aaaaaaaa-9231-1111-1111-111111111111'),
  ('bbbbbbbb-9231-1111-1111-111111111111');

insert into source_policies (source_code, authentication_method, policy_version)
values ('greenhouse', 'none', 'r2-v1');
insert into vacancy_sources (id, source_code, target_key)
values ('cccccccc-9231-1111-1111-111111111111', 'greenhouse', 'acme');
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title)
values (
  'dddddddd-9231-1111-1111-111111111111',
  'greenhouse', 'cccccccc-9231-1111-1111-111111111111', 'gh-prio-1',
  'https://boards.greenhouse.io/acme/jobs/9', 'Senior Platform Engineer'
);

set local role service_role;
insert into fit_analyses (
  candidate_id, vacancy_id, jd_text_available, model_version, prompt_version,
  priority_score, priority_uncapped_score, priority_components, priority_score_version
)
values
  ('aaaaaaaa-9231-1111-1111-111111111111', 'dddddddd-9231-1111-1111-111111111111', false, 'm', 'p',
   77, 77, '{"technical_fit":{"weight":0.2,"value":80,"source":"fit"}}'::jsonb, 'priority-v3'),
  ('bbbbbbbb-9231-1111-1111-111111111111', 'dddddddd-9231-1111-1111-111111111111', false, 'm', 'p',
   12, 12, '{}'::jsonb, 'priority-v3');
reset role;

-- 1-4. all four columns exist with the intended types
select has_column('public', 'fit_analyses', 'priority_score', 'fit_analyses has priority_score');
select has_column('public', 'fit_analyses', 'priority_uncapped_score', 'fit_analyses has priority_uncapped_score');
select has_column('public', 'fit_analyses', 'priority_components', 'fit_analyses has priority_components');
select has_column('public', 'fit_analyses', 'priority_score_version', 'fit_analyses has priority_score_version');

-- 5. the owning candidate can read the new columns with NO grant change —
--    `grant select on <table>` covers columns added after the grant.
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-9231-1111-1111-111111111111"}';
select is(
  (select priority_score from fit_analyses),
  77,
  'the owning candidate can read priority_score with no new grant'
);

-- 6. and only their own row's score
select is(
  (select count(*)::int from fit_analyses where priority_score = 12),
  0,
  'candidate A cannot read candidate B''s priority_score'
);

-- 7. writes are still service-role only
select throws_ok(
  $$update fit_analyses set priority_score = 100
      where candidate_id = 'aaaaaaaa-9231-1111-1111-111111111111'$$,
  '42501',
  null,
  'authenticated cannot UPDATE priority_score'
);
reset role;

-- 8-9. range constraints
set local role service_role;
select throws_ok(
  $$update fit_analyses set priority_score = 101
      where candidate_id = 'aaaaaaaa-9231-1111-1111-111111111111'$$,
  '23514',
  null,
  'priority_score above 100 violates the check constraint'
);
select throws_ok(
  $$update fit_analyses set priority_uncapped_score = -1
      where candidate_id = 'aaaaaaaa-9231-1111-1111-111111111111'$$,
  '23514',
  null,
  'priority_uncapped_score below 0 violates the check constraint'
);
reset role;

select * from finish();
rollback;
