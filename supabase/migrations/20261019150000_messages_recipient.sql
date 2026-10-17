-- THE RECIPIENT HEADER, WHERE THE REPLY TOKEN ARRIVES.
--
-- WHY A COLUMN. The reply token (server/mailbox/replyToken.ts) travels in the plus-address of
-- the candidate's own mailbox, so it comes back in the To header of the employer's reply. That
-- header exists only while the message is being fetched: the matching pass runs later, from a
-- stored row, so without persistence the token is gone by the time anything could act on it.
--
-- RAW, NOT PARSED. This holds the header as received, exactly like auth_results. The verdict -
-- which attempt, if any - is derived at match time, which keeps the extraction rules fixable
-- after the fact: rows are not re-ingestible, so a parsing bug must not be baked into storage.
--
-- NULLABLE, AND NULL MEANS NOT CAPTURED. Messages stored before this migration have no header
-- recorded; so does any payload that carried neither To nor Delivered-To. NULL must never be
-- read as "this message has no reply token", only as "we did not record the recipient".

alter table public.messages add column if not exists recipient text;

comment on column public.messages.recipient is
  'Raw To header (falling back to Delivered-To) as received. Carries the plus-addressed reply token; parsed at match time, never at write time. NULL means NOT CAPTURED, never "no token".';
