begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- Fixture setup as postgres, bypassing RLS (not under test here).
insert into auth.users (id, email) values ('11111111-9001-1111-1111-111111111111', 'ghosted@test.local');
insert into candidate_profiles (id) values ('11111111-9001-1111-1111-111111111111');

-- A source code unique to this file. The suite runs inside the live database,
-- so reusing a seeded code (local_fixture) collides with rows that already
-- exist — every pgTAP file here picks its own.
insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('ghost_fixture', 'none', 'test-v1', array['XX']);

insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-9001-1111-1111-111111111111', 'ghost_fixture', 'ghost-board');

insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title)
values ('eeeeeeee-9001-1111-1111-111111111111', 'ghost_fixture', 'dddddddd-9001-1111-1111-111111111111', 'ghost-job-1', 'https://example.test/jobs/1', 'Ghosted Engineer');

insert into application_plans (id, candidate_id, vacancy_id, gate_results)
values ('ffffffff-9001-1111-1111-111111111111', '11111111-9001-1111-1111-111111111111', 'eeeeeeee-9001-1111-1111-111111111111', '{}'::jsonb);

insert into mailbox_connections (id, candidate_id, provider, status)
values ('cccccccc-9001-1111-1111-111111111111', '11111111-9001-1111-1111-111111111111', 'local_payload', 'connected');

-- One attempt per case, all on the same plan so the join is identical for each
-- and only the variable under test changes.
insert into application_attempts (id, application_plan_id, status, succeeded_at) values
  -- A: succeeded 8 days ago, nothing came back. The case the feature exists for.
  ('aaaa0001-9001-1111-1111-111111111111', 'ffffffff-9001-1111-1111-111111111111', 'succeeded', now() - interval '8 days'),
  -- B: too recent.
  ('aaaa0002-9001-1111-1111-111111111111', 'ffffffff-9001-1111-1111-111111111111', 'succeeded', now() - interval '3 days'),
  -- C: an employer actually replied.
  ('aaaa0003-9001-1111-1111-111111111111', 'ffffffff-9001-1111-1111-111111111111', 'succeeded', now() - interval '8 days'),
  -- D: only an automatic acknowledgement came back.
  ('aaaa0004-9001-1111-1111-111111111111', 'ffffffff-9001-1111-1111-111111111111', 'succeeded', now() - interval '8 days'),
  -- E: a message arrived that nobody has classified yet.
  ('aaaa0005-9001-1111-1111-111111111111', 'ffffffff-9001-1111-1111-111111111111', 'succeeded', now() - interval '8 days'),
  -- F: older than A, so ordering is observable.
  ('aaaa0006-9001-1111-1111-111111111111', 'ffffffff-9001-1111-1111-111111111111', 'succeeded', now() - interval '20 days'),
  -- G: never succeeded.
  ('aaaa0007-9001-1111-1111-111111111111', 'ffffffff-9001-1111-1111-111111111111', 'failed', now() - interval '8 days'),
  -- H: succeeded but with no timestamp (a pre-column row with no evidence).
  ('aaaa0008-9001-1111-1111-111111111111', 'ffffffff-9001-1111-1111-111111111111', 'succeeded', null);

insert into messages (id, mailbox_connection_id, application_attempt_id, provider_message_id, sender, subject) values
  ('bbbb0003-9001-1111-1111-111111111111', 'cccccccc-9001-1111-1111-111111111111', 'aaaa0003-9001-1111-1111-111111111111', 'msg-rejection', 'jobs@acme.test', 'Unfortunately'),
  ('bbbb0004-9001-1111-1111-111111111111', 'cccccccc-9001-1111-1111-111111111111', 'aaaa0004-9001-1111-1111-111111111111', 'msg-ack', 'jobs@acme.test', 'We received your application'),
  ('bbbb0005-9001-1111-1111-111111111111', 'cccccccc-9001-1111-1111-111111111111', 'aaaa0005-9001-1111-1111-111111111111', 'msg-unclassified', 'jobs@acme.test', 'Hello');

insert into response_classifications (message_id, category, model_version) values
  ('bbbb0003-9001-1111-1111-111111111111', 'rejection', 'test-model'),
  ('bbbb0004-9001-1111-1111-111111111111', 'application_received', 'test-model');

-- 1. The base case is detected.
select results_eq(
  $$select application_attempt_id from find_ghosted_attempts(7, 50)
      where application_attempt_id = 'aaaa0001-9001-1111-1111-111111111111'::uuid$$,
  $$values ('aaaa0001-9001-1111-1111-111111111111'::uuid)$$,
  'An application submitted 8 days ago with no reply at all is detected as ghosted'
);

-- 2. Too recent.
select is_empty(
  $$select application_attempt_id from find_ghosted_attempts(7, 50)
      where application_attempt_id = 'aaaa0002-9001-1111-1111-111111111111'::uuid$$,
  'An application submitted only 3 days ago is not ghosted yet'
);

-- 3. An employer reply suppresses it.
select is_empty(
  $$select application_attempt_id from find_ghosted_attempts(7, 50)
      where application_attempt_id = 'aaaa0003-9001-1111-1111-111111111111'::uuid$$,
  'An application with an employer reply is never drafted for'
);

-- 4. The judgement call, asserted rather than assumed: a bare acknowledgement
-- does NOT count as a reply. Without this the feature never fires, because an
-- automatic "we received your application" is the most common mail an ATS sends.
select results_eq(
  $$select application_attempt_id from find_ghosted_attempts(7, 50)
      where application_attempt_id = 'aaaa0004-9001-1111-1111-111111111111'::uuid$$,
  $$values ('aaaa0004-9001-1111-1111-111111111111'::uuid)$$,
  'An application whose only reply is an application_received acknowledgement is still ghosted'
);

-- 5. Unclassified mail is treated conservatively as a reply.
select is_empty(
  $$select application_attempt_id from find_ghosted_attempts(7, 50)
      where application_attempt_id = 'aaaa0005-9001-1111-1111-111111111111'::uuid$$,
  'A linked but unclassified message counts as a reply, so no follow-up is drafted'
);

-- 6. Ordering: oldest first.
select results_eq(
  $$select application_attempt_id from find_ghosted_attempts(7, 50)
      where application_attempt_id in ('aaaa0001-9001-1111-1111-111111111111'::uuid,
                                       'aaaa0006-9001-1111-1111-111111111111'::uuid)$$,
  $$values ('aaaa0006-9001-1111-1111-111111111111'::uuid), ('aaaa0001-9001-1111-1111-111111111111'::uuid)$$,
  'Ghosted applications come back oldest first, so the longest-waiting is drafted first'
);

-- 7. A failed attempt is not an application that went cold.
select is_empty(
  $$select application_attempt_id from find_ghosted_attempts(7, 50)
      where application_attempt_id = 'aaaa0007-9001-1111-1111-111111111111'::uuid$$,
  'An attempt that never succeeded is not ghosted'
);

-- 8. Succeeded with no timestamp: excluded rather than guessed at.
select is_empty(
  $$select application_attempt_id from find_ghosted_attempts(7, 50)
      where application_attempt_id = 'aaaa0008-9001-1111-1111-111111111111'::uuid$$,
  'A succeeded attempt with no succeeded_at is excluded rather than assumed old enough'
);

-- 9. The reported age is real, not a placeholder.
select results_eq(
  $$select days_since_submission from find_ghosted_attempts(7, 50)
      where application_attempt_id = 'aaaa0006-9001-1111-1111-111111111111'::uuid$$,
  $$values (20)$$,
  'The number of days since submission is computed from succeeded_at'
);

-- 10. An existing draft — including a dismissed one — stops re-drafting, so a
-- candidate who said no is not asked again behind their back.
insert into follow_up_drafts (application_attempt_id, draft_text, status, model_version, prompt_version)
values ('aaaa0001-9001-1111-1111-111111111111', 'Draft text.', 'dismissed', 'test-model', 'follow-up-v1');

select is_empty(
  $$select application_attempt_id from find_ghosted_attempts(7, 50)
      where application_attempt_id = 'aaaa0001-9001-1111-1111-111111111111'::uuid$$,
  'An attempt that already has a draft is not detected again, even when that draft was dismissed'
);

select * from finish();
rollback;
