-- The fit-enqueue fan-out is CAPPED.
--
-- WHY THIS TEST EXISTS. Both fan-out triggers insert one fit_analysis_jobs row per
-- VERIFIED/VERIFIED_INCOMPLETE vacancy, and every row is one model call once drained. A live
-- run of ONE candidate selecting ONE role queued 743 rows against the real catalogue, so the
-- cost was O(candidates x verified vacancies) - it grew with the catalogue rather than with
-- candidate activity. This proves the bound: a candidate action queues at most 200 rows,
-- newest first.
--
-- SCOPING NOTE. These triggers fan out over EVERY eligible vacancy, and the live database
-- already holds hundreds, so nothing here asserts a global count of the table. The fixture
-- adds 250 vacancies dated 2027, which makes them unambiguously the newest rows in the
-- database; that pins "which 200" without depending on the wall clock or on what else the
-- database happens to contain.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Fixture (as postgres).
insert into auth.users (id, email) values
  ('aaaaaaaa-9801-1111-1111-111111111111', 'cap-a@test.local');
insert into candidate_profiles (id) values
  ('aaaaaaaa-9801-1111-1111-111111111111');

insert into source_policies (source_code, authentication_method, policy_version)
values ('greenhouse', 'none', 'r2-v1')
on conflict (source_code) do nothing;
insert into vacancy_sources (id, source_code, target_key)
values ('bbbbbbbb-9801-1111-1111-111111111111', 'greenhouse', 'cap-board');

-- 250 ELIGIBLE vacancies. created_at descends as i rises, so i=1 is the newest and i=250
-- the oldest: the cap must keep 1..200 and exclude 201..250.
insert into vacancies (
  id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, trust_status, created_at
)
select
  ('f0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'greenhouse',
  'bbbbbbbb-9801-1111-1111-111111111111',
  'gh-cap-' || i,
  'https://boards.greenhouse.io/cap/jobs/' || i,
  'Cap Role ' || i,
  'VERIFIED',
  timestamptz '2027-01-01 00:00:00+00' - (i || ' minutes')::interval
from generate_series(1, 250) as i;

-- The fact path needs a confirmable fact.
insert into resume_documents (id, candidate_id, storage_path, original_filename, mime_type, byte_size)
values (
  'cccccccc-9801-1111-1111-111111111111',
  'aaaaaaaa-9801-1111-1111-111111111111',
  'aaaaaaaa-9801-1111-1111-111111111111/resume.pdf',
  'resume.pdf', 'application/pdf', 1024
);
insert into extracted_facts (
  id, candidate_id, source_document_id, fact_type, fact_value, extraction_model, extraction_prompt_version
)
values (
  'dddddddd-9801-1111-1111-111111111111',
  'aaaaaaaa-9801-1111-1111-111111111111',
  'cccccccc-9801-1111-1111-111111111111',
  'location', 'Hyderabad, India', 'test-model', 'test-prompt-v1'
);
insert into fact_confirmations (extracted_fact_id, status)
values ('dddddddd-9801-1111-1111-111111111111', 'pending');

-- 1. GUARD. "200 jobs" only proves a cap if more than 200 vacancies were eligible. On a
--    database with fewer, the test would pass for the wrong reason.
select ok(
  (select count(*) from vacancies where trust_status in ('VERIFIED', 'VERIFIED_INCOMPLETE')) > 200,
  'more than 200 eligible vacancies exist, so the cap has something to bite on'
);

-- 2. Nothing is queued before the candidate acts.
select is(
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9801-1111-1111-111111111111'),
  0,
  'no fit jobs before the candidate acts'
);

-- ---------------------------------------------------------------------------
-- PATH 1: selecting a target role.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-9801-1111-1111-111111111111"}';
insert into candidate_selected_roles (candidate_id, role_name)
values ('aaaaaaaa-9801-1111-1111-111111111111', 'Data Engineer');
reset role;

-- 3. THE CAP.
select is(
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9801-1111-1111-111111111111'),
  200,
  'selecting a role fans out to exactly 200 jobs, not one per eligible vacancy'
);

-- 4. Every job is a fixture vacancy, so nothing older than the newest 200 got one.
select is(
  (select count(*)::int from fit_analysis_jobs j
     where j.candidate_id = 'aaaaaaaa-9801-1111-1111-111111111111'
       and j.vacancy_id::text like 'f0000000-0000-4000-8000-%'),
  200,
  'all 200 jobs target the fixture vacancies'
);

-- 5. The 50 OLDEST eligible vacancies are excluded.
select is(
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9801-1111-1111-111111111111'
       and vacancy_id in (
         select ('f0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid
         from generate_series(201, 250) as i
       )),
  0,
  'none of the 50 oldest eligible vacancies is enqueued'
);

-- 6. The boundary itself, so an off-by-one in either direction fails here.
select is(
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9801-1111-1111-111111111111'
       and vacancy_id = ('f0000000-0000-4000-8000-' || lpad('200', 12, '0'))::uuid)::text
  || '/' ||
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9801-1111-1111-111111111111'
       and vacancy_id = ('f0000000-0000-4000-8000-' || lpad('201', 12, '0'))::uuid)::text,
  '1/0',
  'the 200th-newest eligible vacancy is enqueued and the 201st is not'
);

-- ---------------------------------------------------------------------------
-- PATH 2: confirming a fact. Clear first, so a re-arm of the SAME 200 rows cannot be
-- mistaken for a fresh capped fan-out.
-- ---------------------------------------------------------------------------
delete from fit_analysis_jobs where candidate_id = 'aaaaaaaa-9801-1111-1111-111111111111';

set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-9801-1111-1111-111111111111"}';
update fact_confirmations set status = 'confirmed'
  where extracted_fact_id = 'dddddddd-9801-1111-1111-111111111111';
reset role;

-- 7. The fact path is capped too.
select is(
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9801-1111-1111-111111111111'),
  200,
  'confirming a fact fans out to exactly 200 jobs as well'
);

-- 8. ...excluding the same 50 oldest.
select is(
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9801-1111-1111-111111111111'
       and vacancy_id in (
         select ('f0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid
         from generate_series(201, 250) as i
       )),
  0,
  'the fact path excludes the 50 oldest eligible vacancies too'
);

-- 9. Re-confirming re-arms the existing rows rather than adding a 201st.
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-9801-1111-1111-111111111111"}';
update fact_confirmations set status = 'confirmed', updated_at = now()
  where extracted_fact_id = 'dddddddd-9801-1111-1111-111111111111';
reset role;
select is(
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9801-1111-1111-111111111111'),
  200,
  're-confirming does not push the queue beyond the cap'
);

select * from finish();
rollback;
