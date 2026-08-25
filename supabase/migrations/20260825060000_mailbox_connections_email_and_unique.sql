-- R6.1: Gmail OAuth connect flow needs to (a) show the candidate which
-- Google account is connected, and (b) upsert on (candidate_id, provider) so
-- reconnecting the same provider updates the one existing row instead of
-- leaving a stale duplicate behind — Postgres upsert (ON CONFLICT) requires
-- an actual unique constraint to target, which
-- 20260820140000_mailbox_connections.sql didn't add (candidate_id alone is
-- indexed, not unique, since a candidate may eventually connect more than
-- one provider — just not the same provider twice).
--
-- No RLS/grant changes: RLS is row-level, and mailbox_connections_select_own
-- already covers every column for `authenticated`; service_role already has
-- full DML.
alter table public.mailbox_connections
  add column email_address text;

alter table public.mailbox_connections
  add constraint mailbox_connections_candidate_provider_unique unique (candidate_id, provider);
