-- R5.3: verification-method record for a company_reviews row (PRD §14.3
-- "Verification through corporate email, redacted employment document,
-- verified offer/interview evidence or consented mailbox evidence").
-- Schema and RLS only — same "no case-creation logic exists yet" precedent
-- as moderation_cases (20260816214903): actually checking a corporate
-- email domain, redacting an uploaded document, or matching consented
-- mailbox evidence are each their own real feature, none of which exist
-- anywhere in this repository yet. This migration exists so the table and
-- its boundaries (service_role only, same as moderation_cases before its
-- own moderator-role follow-up) are verified before any of that workflow
-- is built.
--
-- One row per verification attempt, not 1:1 with company_reviews — a
-- rejected attempt (e.g. an unreadable document) may be followed by a
-- retry with a different method, and both are worth keeping for the audit
-- trail, same "append, don't overwrite" precedent as moderation_decisions.
create table public.company_review_verifications (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.company_reviews (id) on delete cascade,

  method text not null check (method in (
    'corporate_email',
    'employment_document',
    'offer_interview_evidence',
    'mailbox_evidence'
  )),

  -- Generic JSONB, same "no shape exists yet" reasoning as
  -- moderation_cases.evidence_snapshot — no verification logic exists yet
  -- to populate a more specific shape.
  evidence_snapshot jsonb,

  created_at timestamptz not null default now()
);

create index company_review_verifications_review_id_idx on public.company_review_verifications (review_id);

alter table public.company_review_verifications enable row level security;

-- Service-role only for now, same reasoning as moderation_cases: no
-- verification workflow exists yet to justify a candidate- or
-- moderator-facing grant.
revoke all on public.company_review_verifications from public;
revoke all on public.company_review_verifications from anon;
revoke all on public.company_review_verifications from authenticated;

grant select, insert, update, delete on public.company_review_verifications to service_role;
