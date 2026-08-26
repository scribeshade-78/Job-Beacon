-- R5.4c: links an employer-appeal-sourced moderation_cases row back to
-- the vacancy_appeals row that created it. moderation_cases.source_type
-- already anticipated 'employer_appeal' as a case-creation source (§13.2
-- step 23 "Case created by rule, report or appeal") but had no way to
-- find the appeal a given case came from — this is that link. Nullable:
-- every other source_type (rule/candidate_report/community_report) has
-- no appeal to point to.
--
-- No RLS/grant changes: moderation_cases stays service_role-only: this
-- column is read by getAppealsQueue (server route, service-role), never
-- by a direct client query.
alter table public.moderation_cases add column appeal_id uuid references public.vacancy_appeals (id);

create index moderation_cases_appeal_id_idx on public.moderation_cases (appeal_id);
