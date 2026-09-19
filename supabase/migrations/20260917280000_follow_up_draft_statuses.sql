-- Task C2: the statuses the review UI actually uses.
--
-- C1 defined status as pending_review | approved | dismissed and deliberately
-- omitted 'sent', on the grounds that nothing could reach it — there was no
-- email adapter and no way to send. That reasoning no longer holds: C2 adds an
-- approve endpoint that transitions a draft, and the requirement is that it
-- lands in 'sent'.
--
-- 'approved' is REMOVED rather than kept alongside. C1 added it anticipating a
-- two-step approve-then-send flow; the actual flow is one action ("Approve &
-- Send"), so 'approved' is a state nothing can reach. Leaving an unreachable
-- value in a check constraint is the same defect C1 refused when it declined to
-- invent 'sent' early — a status the schema allows and the code cannot produce
-- is a lie in the schema's own vocabulary.
--
-- WHAT 'sent' DOES NOT MEAN YET, stated here because the column will outlive
-- this phase. Nothing transmits email. The endpoint that writes 'sent' also
-- logs the draft body to the server console and stops there — there is no SMTP
-- client, no mailbox, and no recipient address anywhere in this schema. The
-- status records "the candidate approved this for sending", which is exactly
-- what a later sending phase needs to pick up. Read as "an email went out" it
-- would be false.
alter table public.follow_up_drafts
  drop constraint follow_up_drafts_status_check;

alter table public.follow_up_drafts
  add constraint follow_up_drafts_status_check
  check (status in ('pending_review', 'sent', 'dismissed'));

comment on column public.follow_up_drafts.status is
  'pending_review = awaiting the candidate. sent = the candidate approved it for sending (NO email is actually transmitted yet — the approve endpoint logs the body and stops; real delivery is a later phase). dismissed = the candidate declined it, and the detector will not draft again for that attempt.';
