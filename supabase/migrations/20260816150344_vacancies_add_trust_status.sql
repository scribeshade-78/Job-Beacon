-- Denormalized "current status" pointer for fast candidate-facing
-- filtering (PRD §12.1 status model), mirroring the vacancies (current) /
-- vacancy_versions (history) split already established in R2. The
-- authoritative scored history lives in vacancy_trust_scores; this column
-- is only ever a copy of the latest row's status, written by the R3.4
-- scoring worker (not yet built).
--
-- Nullable, no default: no scoring logic exists yet in R3.1, so newly
-- ingested vacancies have nothing to set this to. NULL means "not yet
-- scored" rather than inventing an eighth status value the PRD doesn't
-- list (its §12.1 table names exactly seven).
--
-- No RLS/grant changes: candidate SELECT already covers every column via
-- the existing vacancies_select_all policy (RLS is row-level, not
-- column-level), and service_role already holds UPDATE on this table from
-- the R2 vacancies migration.
alter table public.vacancies add column trust_status text check (trust_status in (
  'VERIFIED',
  'VERIFIED_INCOMPLETE',
  'UNDER_REVIEW',
  'FLAGGED',
  'BLOCKED',
  'EXPIRED_REMOVED',
  'ACTION_REQUIRED'
));

create index vacancies_trust_status_idx on public.vacancies (trust_status);
