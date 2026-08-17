-- Action-required exception queue (R4.1; PRD §17's seven named exception
-- types, §17.1 action-required UX). Schema and RLS only — no exception
-- detection or resume-after-completion logic exists yet (that's R4.7);
-- this migration exists to have the table and boundaries verified first.
--
-- exception_type is PRD §17's table, verbatim (CAPTCHA, OTP or email
-- code, unknown legal/sensitive question, missing verified fact,
-- assessment/video/interview, unsupported portal, payment or financial
-- request) — same "match the source document's own enumeration exactly"
-- discipline as vacancy_trust_scores.status and moderation_cases.severity.
--
-- payload is generic JSONB (what exactly is missing/blocking — e.g. which
-- fact, which question, which portal), same precedent as
-- application_evidence.payload; expires_at is nullable and mirrors
-- vacancy_appeals.evidence_deadline's naming for the same concept (§17.1
-- "Show deadline or expiry when relevant" — an OTP timeout, an assessment
-- deadline). resolved_at is nullable and set once the candidate completes
-- the requested action (§17.1 "Resume automatically after successful
-- completion") — that write path belongs to R4.7, not this migration.
create table public.action_required_events (
  id uuid primary key default gen_random_uuid(),
  application_attempt_id uuid not null references public.application_attempts (id),

  exception_type text not null check (exception_type in (
    'captcha',
    'otp_or_email_code',
    'unknown_sensitive_question',
    'missing_verified_fact',
    'external_assessment',
    'unsupported_portal',
    'payment_or_financial_request'
  )),

  payload jsonb not null,
  expires_at timestamptz,
  resolved_at timestamptz,

  created_at timestamptz not null default now()
);

create index action_required_events_application_attempt_id_idx on public.action_required_events (application_attempt_id);

alter table public.action_required_events enable row level security;

revoke all on public.action_required_events from public;
revoke all on public.action_required_events from anon;
revoke all on public.action_required_events from authenticated;

-- Candidate-facing read surface (PRD §18.1 "Action Required" nav item),
-- transitively owned through application_attempts ->
-- application_plans.candidate_id, two joins deep. No mutation grant for
-- authenticated — a candidate resolves the underlying exception (e.g.
-- confirms a fact, completes an OTP) through its own dedicated flow, not
-- by writing to this table directly; the worker marks resolved_at once
-- that's observed.
grant select on public.action_required_events to authenticated;
grant select, insert, update, delete on public.action_required_events to service_role;

create policy "action_required_events_select_own"
  on public.action_required_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.application_attempts aa
      join public.application_plans ap on ap.id = aa.application_plan_id
      where aa.id = action_required_events.application_attempt_id
        and ap.candidate_id = (select auth.uid())
    )
  );
