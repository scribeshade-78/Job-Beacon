begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

-- Task H2. The existing interviews_rls.test.sql covers the message -> mailbox
-- path, which this task left intact. What is new, and what this file covers, is
-- the calendar path: an interview with NO message_id, owned through
-- application_attempts -> application_plans, plus the append-only change log.

insert into auth.users (id, email) values
  ('c0c0c0c0-ca1e-4000-8000-00000000000a', 'cal-candidate-a@test.local'),
  ('c0c0c0c0-ca1e-4000-8000-00000000000b', 'cal-candidate-b@test.local');

insert into candidate_profiles (id) values
  ('c0c0c0c0-ca1e-4000-8000-00000000000a'),
  ('c0c0c0c0-ca1e-4000-8000-00000000000b');

insert into companies (id, displayed_name, domain)
values ('c0c0c0c0-ca1e-4000-8000-0000000000c2', 'Cal Fixture Co', 'calfixture.test');

-- vacancy_source_id is looked up rather than hardcoded: it is seeded by a
-- migration, and a literal here would silently rot if that seed ever changed.
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
select 'c0c0c0c0-ca1e-4000-8000-0000000000c3', 'local_fixture', vs.id, 'cal-vac-1', 'https://calfixture.test/jobs/1', 'Interview Fixture Role', 'c0c0c0c0-ca1e-4000-8000-0000000000c2'
from vacancy_sources vs
where vs.source_code = 'local_fixture';

insert into application_plans (id, candidate_id, vacancy_id, gate_results)
values ('c0c0c0c0-ca1e-4000-8000-0000000000c4', 'c0c0c0c0-ca1e-4000-8000-00000000000a', 'c0c0c0c0-ca1e-4000-8000-0000000000c3', '{}'::jsonb);

insert into application_attempts (id, application_plan_id, status)
values ('c0c0c0c0-ca1e-4000-8000-0000000000c5', 'c0c0c0c0-ca1e-4000-8000-0000000000c4', 'pending');

insert into mailbox_connections (id, candidate_id, provider, status, email_address)
values ('c0c0c0c0-ca1e-4000-8000-0000000000c1', 'c0c0c0c0-ca1e-4000-8000-00000000000a', 'gmail', 'connected', 'cal-candidate-a@test.local');

-- 1. The §13.1 lifecycle CHECK rejects a value the PRD does not list.
select throws_ok(
  $$insert into interviews (id, calendar_event_id, status) values ('c0c0c0c0-ca1e-4000-8000-0000000000c9', 'evt-bad', 'no_show')$$,
  '23514',
  null,
  'interviews.status rejects a lifecycle value outside RI PRD 13.1'
);

set local role service_role;

-- 2. A calendar-sourced interview needs no message at all.
select lives_ok(
  $$insert into interviews (id, application_attempt_id, calendar_connection_id, calendar_event_id, scheduled_at, timezone, status, source)
    values ('c0c0c0c0-ca1e-4000-8000-0000000000c6', 'c0c0c0c0-ca1e-4000-8000-0000000000c5', 'c0c0c0c0-ca1e-4000-8000-0000000000c1', 'evt-1', now() + interval '2 days', 'Asia/Kolkata', 'invited', 'calendar')$$,
  'service_role can insert a calendar interview with no message_id'
);

-- 3. An interview belonging to nobody is representable (the sync can record a
--    cancellation it cannot attribute), and stays invisible to candidates.
select lives_ok(
  $$insert into interviews (id, calendar_event_id, status, source)
    values ('c0c0c0c0-ca1e-4000-8000-0000000000c7', 'evt-orphan', 'invited', 'calendar')$$,
  'an interview linked to neither a message nor an application is representable'
);

-- 4. One calendar event maps to one interview.
select throws_ok(
  $$insert into interviews (id, calendar_connection_id, calendar_event_id, status, source)
    values ('c0c0c0c0-ca1e-4000-8000-0000000000c8', 'c0c0c0c0-ca1e-4000-8000-0000000000c1', 'evt-1', 'invited', 'calendar')$$,
  '23505',
  null,
  'a second interview for the same calendar event is refused'
);

-- 5. The change log records the previous values, not only the new ones.
select lives_ok(
  $$insert into interview_event_changes (interview_id, change_type, source, summary, previous_values, new_values)
    values ('c0c0c0c0-ca1e-4000-8000-0000000000c6', 'rescheduled', 'calendar', 'Moved by 30 minutes.', '{"scheduled_at":"2026-09-25T08:30:00Z"}'::jsonb, '{"scheduled_at":"2026-09-25T09:00:00Z"}'::jsonb)$$,
  'service_role can append a change with both before and after values'
);

-- 6. A change type outside the detected set is refused.
select throws_ok(
  $$insert into interview_event_changes (interview_id, change_type, source, summary)
    values ('c0c0c0c0-ca1e-4000-8000-0000000000c6', 'vibes_changed', 'calendar', 'x')$$,
  '23514',
  null,
  'interview_event_changes.change_type rejects an undetected change type'
);

reset role;

-- As Candidate A (owner through the application path, with no message involved)
set local role authenticated;
set local request.jwt.claim.sub = 'c0c0c0c0-ca1e-4000-8000-00000000000a';

-- 7. THE NEW POLICY BRANCH: visible via application_attempts -> application_plans.
select results_eq(
  $$select calendar_event_id from interviews where id = 'c0c0c0c0-ca1e-4000-8000-0000000000c6'$$,
  $$values ('evt-1'::text)$$,
  'Candidate A sees their own calendar interview, which has no message_id'
);

-- 8. The orphan interview belongs to no candidate and is therefore invisible.
select is_empty(
  $$select id from interviews where id = 'c0c0c0c0-ca1e-4000-8000-0000000000c7'$$,
  'an unlinked interview is not visible to a candidate'
);

-- 9. The owner can read their own interview's change history.
select results_eq(
  $$select change_type from interview_event_changes where interview_id = 'c0c0c0c0-ca1e-4000-8000-0000000000c6'$$,
  $$values ('rescheduled'::text)$$,
  'Candidate A sees the change history of their own interview'
);

-- 10. The change log is append-only: no UPDATE grant exists at all.
select throws_ok(
  $$update interview_event_changes set summary = 'rewritten' where interview_id = 'c0c0c0c0-ca1e-4000-8000-0000000000c6'$$,
  '42501',
  null,
  'a candidate cannot rewrite a detected interview change'
);

select throws_ok(
  $$delete from interview_event_changes where interview_id = 'c0c0c0c0-ca1e-4000-8000-0000000000c6'$$,
  '42501',
  null,
  'a candidate cannot delete a detected interview change'
);
reset role;

-- As Candidate B (not the owner of anything here)
set local role authenticated;
set local request.jwt.claim.sub = 'c0c0c0c0-ca1e-4000-8000-00000000000b';

-- 11. Candidate B cannot see Candidate A's calendar interview.
select is_empty(
  $$select id from interviews where id = 'c0c0c0c0-ca1e-4000-8000-0000000000c6'$$,
  'Candidate B cannot see Candidate A''s calendar interview'
);

-- 12. Candidate B cannot see its change history either.
select is_empty(
  $$select id from interview_event_changes where interview_id = 'c0c0c0c0-ca1e-4000-8000-0000000000c6'$$,
  'Candidate B cannot see Candidate A''s interview change history'
);
reset role;

select * from finish();
rollback;
