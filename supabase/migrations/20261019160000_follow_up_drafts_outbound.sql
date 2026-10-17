-- THE OUTBOUND DELIVERY RECORD, ON THE DRAFT ITSELF.
--
-- WHY THESE COLUMNS LIVE HERE. One follow-up is one email to one verified recipient. A second
-- table would add a join and a second place for "was this sent" to disagree with itself, which is
-- the one question this table now has to answer without ambiguity.
--
-- 'sending' IS A NEW STATUS AND IT IS LOAD-BEARING. Sending is irreversible, so the row is claimed
-- BEFORE the provider call and settled after it. Without an intermediate state, a crash between
-- "the provider accepted" and "the row was updated" leaves an email that went out with no record
-- of it — the failure this whole slice exists to prevent. The same claim-then-settle shape as
-- begin_application_submission, for the same reason.
--
-- LEGACY 'sent' ROWS. Until this migration 'sent' meant "the candidate approved it"; nothing was
-- transmitted (see 20260917280000). Those rows have sent_at IS NULL, and that is how they are
-- distinguished from a real send. They are deliberately NOT re-opened to 'pending_review': that
-- would re-surface a decision the candidate already made. A one-line backfill can do it later if
-- the founder wants those drafts re-approvable.

alter table public.follow_up_drafts
  drop constraint follow_up_drafts_status_check;

alter table public.follow_up_drafts
  add constraint follow_up_drafts_status_check
  check (status in ('pending_review', 'sending', 'sent', 'dismissed'));

alter table public.follow_up_drafts
  add column if not exists subject text,
  add column if not exists recipient_address text,
  -- The message the recipient address was READ FROM. Stored as evidence: the anti-abuse rule is
  -- "only write to an address the employer wrote FROM", and this is the row that proves it.
  add column if not exists recipient_message_id uuid references public.messages (id) on delete set null,
  add column if not exists reply_address text,
  add column if not exists body_sha256 text,
  add column if not exists consent_version text,
  add column if not exists approved_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists provider_message_id text,
  add column if not exists sending_started_at timestamptz,
  add column if not exists send_attempts integer not null default 0,
  add column if not exists last_send_error text;

-- The recovery pass scans ONLY stuck claims, so the index is partial.
create index if not exists follow_up_drafts_sending_idx
  on public.follow_up_drafts (sending_started_at)
  where status = 'sending';

comment on column public.follow_up_drafts.status is
  'pending_review = awaiting the candidate. sending = CLAIMED for delivery, provider call in flight (a stuck row is reconciled by the recovery pass). sent = the provider accepted it; sent_at is not null for a real send, and null only for legacy pre-outbound approvals. dismissed = the candidate declined it.';

comment on column public.follow_up_drafts.recipient_address is
  'The employer address this was sent to, parsed from messages.sender of recipient_message_id. Never user-supplied.';

comment on column public.follow_up_drafts.recipient_message_id is
  'The inbound message whose From header supplied recipient_address — the evidence for "we only wrote to an address the employer wrote from".';

comment on column public.follow_up_drafts.reply_address is
  'The plus-addressed Reply-To minted for this attempt, so support can trace a reply back to this send.';

comment on column public.follow_up_drafts.body_sha256 is
  'sha256 of the exact body approved. The record cannot drift from what the candidate reviewed.';

comment on column public.follow_up_drafts.provider_message_id is
  'The transport message id. NULL with status=sent means a legacy approval, not a transmitted email.';
