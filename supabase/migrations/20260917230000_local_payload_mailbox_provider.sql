-- Task Z: a mailbox provider for locally-supplied email payloads.
--
-- The email feedback loop needs somewhere to put a parsed message, and
-- public.messages.mailbox_connection_id is a required foreign key — so a
-- connection row has to exist even when no real mailbox was ever connected.
-- Right now none does: the Gmail OAuth flow has never been completed in this
-- environment, so there are zero mailbox_connections rows.
--
-- WHY NOT REUSE 'gmail'. Because it would be a lie with consequences: the
-- poller claims every row WHERE provider = 'gmail' AND status = 'connected',
-- so a fake Gmail row would be polled forever, fail every time (no refresh
-- token to decrypt), and eventually flip itself to 'error' — leaving a broken
-- mailbox on the candidate's Integrations page and a permanently failing
-- worker cycle. A distinct provider is never claimed by anything.
--
-- status is still 'connected' rather than 'pending', because 'connected' is
-- what the surrounding code treats as "this connection can carry messages";
-- nothing keys on it beyond the poller's provider filter. It does not claim a
-- mailbox exists — email_address stays null and the UI labels the provider.
alter table public.mailbox_connections
  drop constraint if exists mailbox_connections_provider_check;

alter table public.mailbox_connections
  add constraint mailbox_connections_provider_check
  check (provider in ('gmail', 'outlook', 'local_payload'));

comment on column public.mailbox_connections.provider is
  'gmail | outlook = real OAuth mailbox connections that the poller claims. local_payload = messages supplied directly as local email payloads (server/integrations/emailParser.ts) for testing the response loop without a mailbox; never polled.';
