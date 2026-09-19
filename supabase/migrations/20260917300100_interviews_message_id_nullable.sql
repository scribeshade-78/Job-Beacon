-- Task H2 correction: interviews.message_id must allow NULL.
--
-- FOUND BY THE pgTAP TEST, NOT BY REVIEW. The H2 migration added
-- calendar_event_id and calendar_connection_id so an interview could come from
-- the calendar, but left the pre-existing "message_id uuid NOT NULL" in place.
-- The two are contradictory: an interview detected from a Google Calendar event
-- has no message at all, so the row the sync produces could never be inserted.
-- Every unit test passed because they run against a fake client that does not
-- enforce column constraints; calendar_interviews_rls.test.sql caught it on the
-- first real insert.
--
-- The original constraint encoded a real assumption — that interviews only ever
-- arrived by email — which RI PRD FR-012 and §13.1 remove. This migration drops
-- exactly that assumption and nothing else.
--
-- The alternative shape, a CHECK requiring one of message_id or
-- calendar_event_id to be present, is deliberately NOT added: the sync can
-- legitimately record an interview it cannot yet attribute to an application or
-- a message, and the existing interviews_rls test depends on such a row being
-- representable. Attribution is the application link's job, not this column's.
alter table public.interviews
  alter column message_id drop not null;

comment on column public.interviews.message_id is
  'The email this interview was detected from, when there was one. NULL for an interview detected from a calendar event (RI PRD FR-012), which is why this column is nullable as of Task H2.';
