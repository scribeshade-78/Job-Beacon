begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

-- Fixture (as postgres).
insert into auth.users (id, email) values
  ('aaaaaaaa-9213-1111-1111-111111111111', 'trig-a@test.local');
insert into candidate_profiles (id) values
  ('aaaaaaaa-9213-1111-1111-111111111111');
insert into resume_documents (id, candidate_id, storage_path, original_filename, mime_type, byte_size)
values (
  'cccccccc-9213-1111-1111-111111111111',
  'aaaaaaaa-9213-1111-1111-111111111111',
  'aaaaaaaa-9213-1111-1111-111111111111/resume.pdf',
  'resume.pdf', 'application/pdf', 1024
);
insert into extracted_facts (id, candidate_id, source_document_id, fact_type, fact_value, extraction_model, extraction_prompt_version)
values (
  'dddddddd-9213-1111-1111-111111111111',
  'aaaaaaaa-9213-1111-1111-111111111111',
  'cccccccc-9213-1111-1111-111111111111',
  'location', 'Bengaluru, India', 'test-model', 'test-prompt-v1'
);
insert into fact_confirmations (extracted_fact_id, status)
values ('dddddddd-9213-1111-1111-111111111111', 'pending');

insert into source_policies (source_code, authentication_method, policy_version)
values ('greenhouse', 'none', 'r2-v1');
insert into vacancy_sources (id, source_code, target_key)
values ('eeeeeeee-9213-1111-1111-111111111111', 'greenhouse', 'acme');
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, trust_status)
values
  ('f1111111-9213-1111-1111-111111111111', 'greenhouse', 'eeeeeeee-9213-1111-1111-111111111111', 'gh-verified',
   'https://boards.greenhouse.io/acme/jobs/1', 'Verified Role', 'VERIFIED'),
  ('f2222222-9213-1111-1111-111111111111', 'greenhouse', 'eeeeeeee-9213-1111-1111-111111111111', 'gh-review',
   'https://boards.greenhouse.io/acme/jobs/2', 'Under Review Role', 'UNDER_REVIEW');

-- 0. no jobs yet. Scoped to this file's own two fixture vacancies: the live
--    database already holds fit_analysis_jobs rows for real candidates, so a
--    global count only ever equalled 0 on an empty one.
select is(
  (select count(*)::int from fit_analysis_jobs
     where vacancy_id in ('f1111111-9213-1111-1111-111111111111',
                          'f2222222-9213-1111-1111-111111111111')),
  0,
  'no fit_analysis_jobs before any fact is confirmed'
);

-- Confirm the fact via the browser-side RLS UPDATE path.
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-9213-1111-1111-111111111111"}';
update fact_confirmations set status = 'confirmed'
  where extracted_fact_id = 'dddddddd-9213-1111-1111-111111111111';
reset role;

-- 1. exactly one job was enqueued (for the VERIFIED vacancy only). The trigger
--    fans out over every VERIFIED vacancy for the confirming candidate, so the
--    assertion is scoped to this file's two fixture vacancies — a global count
--    only held on an empty database.
select is(
  (select count(*)::int from fit_analysis_jobs
     where vacancy_id in ('f1111111-9213-1111-1111-111111111111',
                          'f2222222-9213-1111-1111-111111111111')),
  1,
  'confirming a fact enqueues one fit_analysis_jobs row'
);

-- 2. it targets the VERIFIED vacancy — scoped to the fixture's own vacancies,
--    since the fan-out also touches every real VERIFIED vacancy
select is(
  (select vacancy_id::text from fit_analysis_jobs
     where vacancy_id in ('f1111111-9213-1111-1111-111111111111',
                          'f2222222-9213-1111-1111-111111111111')),
  'f1111111-9213-1111-1111-111111111111',
  'the enqueued job targets the VERIFIED vacancy'
);

-- 3. it targets the confirming candidate — asserted across the fixture
--    vacancies, which no other candidate can hold a job on
select is(
  (select candidate_id::text from fit_analysis_jobs
     where vacancy_id in ('f1111111-9213-1111-1111-111111111111',
                          'f2222222-9213-1111-1111-111111111111')),
  'aaaaaaaa-9213-1111-1111-111111111111',
  'the enqueued job targets the confirming candidate'
);

-- 4. it is pending (same fixture scoping)
select is(
  (select status from fit_analysis_jobs
     where vacancy_id in ('f1111111-9213-1111-1111-111111111111',
                          'f2222222-9213-1111-1111-111111111111')),
  'pending',
  'the enqueued job is pending'
);

-- 5. re-confirming an already-confirmed fact enqueues nothing new
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-9213-1111-1111-111111111111"}';
update fact_confirmations set status = 'confirmed', updated_at = now()
  where extracted_fact_id = 'dddddddd-9213-1111-1111-111111111111';
reset role;
select is(
  (select count(*)::int from fit_analysis_jobs
     where vacancy_id in ('f1111111-9213-1111-1111-111111111111',
                          'f2222222-9213-1111-1111-111111111111')),
  1,
  're-confirming an already-confirmed fact does not add another job'
);

select * from finish();
rollback;
