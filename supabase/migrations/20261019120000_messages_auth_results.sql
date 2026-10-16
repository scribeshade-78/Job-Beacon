-- SPF/DKIM PROVENANCE, STORED WHERE THE MATCHER CAN USE IT.
--
-- WHY IT NEEDS A COLUMN. The matcher scores a message on company, role and job id - all of which
-- an attacker can either read off a public job board or guess. The one signal that speaks to WHO
-- SENT THIS is the receiving provider's own SPF/DKIM verdict, and that verdict arrives on a header
-- at POLL time while the matching decision happens in a LATER batch. Without persistence the
-- header is gone by then, so the plumbing starts here.
--
-- NULLABLE ON PURPOSE. Existing rows have no verdict, and so does any provider that does not send
-- one. NULL must mean "unknown", never "passed" - a matcher that reads absence as trust is worse
-- than one that never checks at all.

alter table public.messages add column if not exists auth_results text;

comment on column public.messages.auth_results is
  'Raw Authentication-Results header from the receiving provider (SPF/DKIM/DMARC verdicts). NULL means UNKNOWN, never passed. Persisted at poll time because matching happens in a later batch.';
