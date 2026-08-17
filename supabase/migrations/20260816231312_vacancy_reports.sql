-- Candidate/community reports (PRD §13.1: "Report fake job, payment
-- request, impersonation, salary mismatch, expired job or misleading
-- remote status" -> "Create a case with abuse controls and evidence").
-- Deliberately a separate table from moderation_cases: a report is the
-- raw candidate-submitted input; whether/when it becomes (or gets merged
-- into) a moderation_cases row is triage logic this migration doesn't
-- build. moderation_case_id is nullable and set once that triage happens.
--
-- §13.4 "Candidate reports are rate-limited and abuse-scored" is NOT
-- implemented here — that needs time-windowed application logic (a count
-- of a candidate's reports in a rolling window), which is a real gap, not
-- solved by a schema constraint. This migration only gets the report
-- durably recorded.
create table public.vacancy_reports (
  id uuid primary key default gen_random_uuid(),
  vacancy_id uuid not null references public.vacancies (id),
  reporter_id uuid not null references auth.users (id),

  category text not null check (category in (
    'fake_job',
    'payment_request',
    'impersonation',
    'salary_mismatch',
    'expired_job',
    'misleading_remote_status'
  )),

  description text,
  moderation_case_id uuid references public.moderation_cases (id),

  created_at timestamptz not null default now()
);

create index vacancy_reports_vacancy_id_idx on public.vacancy_reports (vacancy_id);
create index vacancy_reports_reporter_id_idx on public.vacancy_reports (reporter_id);
create index vacancy_reports_moderation_case_id_idx on public.vacancy_reports (moderation_case_id);

alter table public.vacancy_reports enable row level security;

revoke all on public.vacancy_reports from public;
revoke all on public.vacancy_reports from anon;
revoke all on public.vacancy_reports from authenticated;

-- Candidates can submit and read their own reports (not edit or withdraw
-- them — a submitted report is evidence, matching the immutability
-- discipline the rest of R3 already applies to trust/moderation data).
grant select, insert on public.vacancy_reports to authenticated;

create policy "vacancy_reports_select_own"
  on public.vacancy_reports
  for select
  to authenticated
  using (reporter_id = auth.uid());

create policy "vacancy_reports_insert_own"
  on public.vacancy_reports
  for insert
  to authenticated
  with check (reporter_id = auth.uid());

-- Moderators need to see all reports to triage them into cases (R3.6's
-- is_moderator() policy pattern).
create policy "vacancy_reports_select_moderator"
  on public.vacancy_reports
  for select
  to authenticated
  using (is_moderator());

grant select, insert, update, delete on public.vacancy_reports to service_role;
