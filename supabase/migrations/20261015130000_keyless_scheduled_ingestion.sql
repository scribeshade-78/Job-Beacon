-- ===========================================================================
-- Step 6 - enable the REVIEWED keyless sources for the scheduled pull.
--
-- WHY THESE ROWS WERE DISABLED. Each source's own migration created its
-- vacancy_sources row with enabled = false and recorded why: the only scheduled
-- ingestion path was runIngestionBatch, which polls EVERY enabled target on every tick
-- whether or not anyone asked. Enabling Remotive or Arbeitnow then would have spent a
-- third-party request every couple of minutes, indefinitely, for a source designed to be
-- agent-triggered.
--
-- WHAT CHANGED. server/schedulerTasks.ts now runs keyless-ingestion-enqueue, which
-- queues ONLY KEYLESS_SCHEDULED_SOURCE_CODES on a conservative six-hour cadence, and the
-- existing ingestion-drain processes them. The unattended path is now a deliberate,
-- bounded, keyless-only sweep rather than "every enabled target on every tick".
--
-- WHY THE MUSE IS DELIBERATELY ABSENT. Its source_policies row records
-- policy_version = 'themuse-tou-review-pending' with last_legal_review_at = NULL: those
-- terms have NOT been reviewed. Its DiscoveryAdapter IS registered, so the port is done
-- and the source is one UPDATE away — but putting an unreviewed source on an unattended
-- poll is a compliance decision this migration must not make. Re-review the row, then
-- add the same UPDATE for themuse.
--
-- THIS DOES NOT REINTRODUCE THE ORIGINAL PROBLEM. All three keyless adapters declare
-- completesSweep = false, so worker.ts does NOT run markUnseenVacanciesExpired for them:
-- a bounded page cannot expire the rest of the corpus. Greenhouse and Lever keep that
-- sweep because a board IS the whole target.
--
-- SIDE EFFECT, RECORDED RATHER THAN SURPRISING: the manual POST
-- /api/opportunities/refresh route enqueues every ENABLED target, so it will now also
-- queue Remotive and Arbeitnow. Both are keyless, free and unthrottled by a lifetime
-- quota, so that is acceptable; it is stated here because it is not obvious from the
-- button's label.
-- ===========================================================================

update public.vacancy_sources
   set enabled = true
 where source_code = 'remotive'
   and target_key = 'remotive-live';

update public.vacancy_sources
   set enabled = true
 where source_code = 'arbeitnow'
   and target_key = 'job-board-feed';
