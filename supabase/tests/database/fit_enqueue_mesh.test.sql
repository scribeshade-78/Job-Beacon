-- Opportunity Intelligence Phase 2.3b — the re-enqueue mesh that keeps the
-- stored priority score on fit_analyses fresh.
--
-- Three trigger paths under test:
--   * fit_enqueue_on_message_linked_trigger    (matcher links a classified message)
--   * fit_enqueue_on_classification_trigger    (classifier writes for a linked message)
--   * fit_enqueue_on_selected_roles_trigger    (candidate edits target roles)
--
-- The message-side triggers must each be a no-op until BOTH halves exist
-- (classification AND application link), because poll.ts classifies before
-- matchBatch.ts links.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- Fixture (as postgres).
insert into auth.users (id, email) values
  ('aaaaaaaa-9232-1111-1111-111111111111', 'mesh-a@test.local');
insert into candidate_profiles (id) values
  ('aaaaaaaa-9232-1111-1111-111111111111');

insert into source_policies (source_code, authentication_method, policy_version)
values ('greenhouse', 'none', 'r2-v1');
insert into vacancy_sources (id, source_code, target_key)
values ('bbbbbbbb-9232-1111-1111-111111111111', 'greenhouse', 'acme');
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, trust_status)
values
  ('cccccccc-9232-1111-1111-111111111111', 'greenhouse', 'bbbbbbbb-9232-1111-1111-111111111111', 'gh-mesh-1',
   'https://boards.greenhouse.io/acme/jobs/1', 'Senior Platform Engineer', 'VERIFIED'),
  ('cdcdcdcd-9232-1111-1111-111111111111', 'greenhouse', 'bbbbbbbb-9232-1111-1111-111111111111', 'gh-mesh-2',
   'https://boards.greenhouse.io/acme/jobs/2', 'Flagged Role', 'FLAGGED');

insert into application_plans (id, candidate_id, vacancy_id, gate_results)
values ('dddddddd-9232-1111-1111-111111111111', 'aaaaaaaa-9232-1111-1111-111111111111',
        'cccccccc-9232-1111-1111-111111111111', '{}'::jsonb);
insert into application_attempts (id, application_plan_id, status)
values ('eeeeeeee-9232-1111-1111-111111111111', 'dddddddd-9232-1111-1111-111111111111', 'pending');

insert into mailbox_connections (id, candidate_id, provider, status)
values ('ffffffff-9232-1111-1111-111111111111', 'aaaaaaaa-9232-1111-1111-111111111111', 'gmail', 'connected');
-- Two messages: one to exercise classify-then-link, one for link-then-classify.
insert into messages (id, mailbox_connection_id, provider_message_id, subject)
values
  ('f1111111-9232-1111-1111-111111111111', 'ffffffff-9232-1111-1111-111111111111', 'msg-1', 'Interview invite'),
  ('f2222222-9232-1111-1111-111111111111', 'ffffffff-9232-1111-1111-111111111111', 'msg-2', 'Re: your application');

set local role service_role;

-- 0. clean slate. Scoped to this file's own candidate and its two fixture
--    vacancies: the live database already holds jobs for real candidates, so a
--    global count only ever equalled 0 on an empty one.
select is(
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
       and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                          'cdcdcdcd-9232-1111-1111-111111111111')),
  0,
  'no fit_analysis_jobs before any signal'
);

-- 1. Classifying an UNLINKED message enqueues nothing: application_attempt_id
--    is still NULL, which is the normal poll.ts ordering.
insert into response_classifications (message_id, category, model_version, prompt_version)
values ('f1111111-9232-1111-1111-111111111111', 'interview', 'classifier-v0', 'message-classification-v1');
select is(
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
       and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                          'cdcdcdcd-9232-1111-1111-111111111111')),
  0,
  'classifying a message that is not linked to an application enqueues nothing'
);

-- 2. The matcher then links it -> now both halves exist, so one job appears.
update messages set application_attempt_id = 'eeeeeeee-9232-1111-1111-111111111111'
  where id = 'f1111111-9232-1111-1111-111111111111';
select is(
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
       and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                          'cdcdcdcd-9232-1111-1111-111111111111')),
  1,
  'linking an already-classified message enqueues exactly one fit_analysis_jobs row'
);

-- 3. it targets the right (candidate, vacancy) pair
-- scoped to the fixture vacancies, so the pair below is this file's own row
-- and not one of the live queue's
select is(
  (select candidate_id::text || '|' || vacancy_id::text from fit_analysis_jobs
     where vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                          'cdcdcdcd-9232-1111-1111-111111111111')),
  'aaaaaaaa-9232-1111-1111-111111111111|cccccccc-9232-1111-1111-111111111111',
  'the enqueued job targets the message''s candidate and vacancy'
);

-- 4. and it is pending
select is(
  (select status from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
       and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                          'cdcdcdcd-9232-1111-1111-111111111111')),
  'pending',
  'the enqueued job is pending'
);

-- 5. Re-classification of an already-linked message (a prompt-version
--    backfill) re-arms the same row rather than adding another. Drive the
--    job to 'done' first so the re-arm is observable.
-- fixture manipulation, scoped to this file's own rows so it cannot disturb
-- the live queue
update fit_analysis_jobs set status = 'done', attempts = 3
  where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
    and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                       'cdcdcdcd-9232-1111-1111-111111111111');
update response_classifications set category = 'offer', prompt_version = 'message-classification-v2'
  where message_id = 'f1111111-9232-1111-1111-111111111111';
select is(
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
       and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                          'cdcdcdcd-9232-1111-1111-111111111111')),
  1,
  're-classifying a linked message does not add a second job'
);

-- 6. ...and that row is back to pending with attempts reset
select is(
  (select status || '/' || attempts::text from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
       and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                          'cdcdcdcd-9232-1111-1111-111111111111')),
  'pending/0',
  're-classifying a linked message re-arms the existing job to pending'
);

-- 7. Linking a message that has NO classification enqueues nothing.
update fit_analysis_jobs set status = 'done'
  where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
    and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                       'cdcdcdcd-9232-1111-1111-111111111111');
update messages set application_attempt_id = 'eeeeeeee-9232-1111-1111-111111111111'
  where id = 'f2222222-9232-1111-1111-111111111111';
select is(
  (select count(*)::int from fit_analysis_jobs
     where status = 'pending'
       and candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
       and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                          'cdcdcdcd-9232-1111-1111-111111111111')),
  0,
  'linking a message with no classification enqueues nothing'
);

reset role;

-- 8. Selecting a target role (browser-side RLS write) enqueues for the
--    candidate's VERIFIED vacancies only.
-- scoped to this file's candidate so the reset cannot disturb the live queue
-- (the surrounding transaction rolls back either way)
delete from fit_analysis_jobs
  where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111';
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-9232-1111-1111-111111111111"}';
insert into candidate_selected_roles (candidate_id, role_name)
values ('aaaaaaaa-9232-1111-1111-111111111111', 'Platform Engineer');
reset role;

-- the fan-out also covers every real VERIFIED vacancy, so this counts only
-- the two fixture vacancies
select is(
  (select count(*)::int from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
       and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                          'cdcdcdcd-9232-1111-1111-111111111111')),
  1,
  'selecting a target role enqueues one job (the VERIFIED vacancy only)'
);

-- 9. the FLAGGED vacancy is not enqueued
select is(
  (select vacancy_id::text from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
       and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                          'cdcdcdcd-9232-1111-1111-111111111111')),
  'cccccccc-9232-1111-1111-111111111111',
  'the FLAGGED vacancy is not enqueued by a preference change'
);

-- 10. Removing a role re-arms too (deleting a role changes what matches).
set local role service_role;
update fit_analysis_jobs set status = 'done'
  where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
    and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                       'cdcdcdcd-9232-1111-1111-111111111111');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-9232-1111-1111-111111111111"}';
delete from candidate_selected_roles where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111';
reset role;

select is(
  (select status from fit_analysis_jobs
     where candidate_id = 'aaaaaaaa-9232-1111-1111-111111111111'
       and vacancy_id in ('cccccccc-9232-1111-1111-111111111111',
                          'cdcdcdcd-9232-1111-1111-111111111111')),
  'pending',
  'removing a target role re-arms the fit analysis job'
);

select * from finish();
rollback;
