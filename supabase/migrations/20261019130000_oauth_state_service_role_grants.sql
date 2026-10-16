-- OAUTH_STATE WAS THE ONE TABLE MISSING ITS REVOKE/GRANT BLOCK.
--
-- WHY. 20261018120000 created this table with no privileges at all. Every other table in this
-- repository (20260812231617_candidate_profiles, 20260820140000_mailbox_connections, ...) revokes
-- the base template's leftovers and grants back exactly what its slice needs. This one did not, so
-- service_role kept only REFERENCES/TRIGGER/TRUNCATE from ALTER DEFAULT PRIVILEGES.
--
-- WHY THAT BROKE THE FEATURE. service_role BYPASSES RLS but NOT table privileges — the same trap
-- 20260917150000 documented for candidate_profiles. startMailboxConnect INSERTs the nonce and
-- code_verifier, and completeMailboxConnect's DELETE ... RETURNING consumes them, both through the
-- service-role client. Before this migration every attempt failed with:
--
--   permission denied for table oauth_state   (SQLSTATE 42501)
--
-- The replay protection and PKCE were unreachable in the running system — the handshake could not
-- write or consume a single row — while the mocked unit test stayed green, because a fake client
-- cannot fail a GRANT it never issues. Confirmed against the live local stack over PostgREST, not
-- inferred from reading the migration: server/integration/mailboxConnectReplay.db.integration.test.ts
-- failed with that exact error before this file existed, and is the regression guard for it.
--
-- SELECT IS REQUIRED AS WELL AS DELETE. DELETE ... RETURNING checks SELECT privilege on the
-- returned column, which is why completeMailboxConnect returns code_verifier from the consume.
--
-- NO UPDATE, DELIBERATELY. The handshake only inserts (authorize) and deletes (callback); a nonce
-- is never rewritten, so UPDATE is not granted.
--
-- CLIENT ROLES GET NOTHING. oauth_state is a server-side handshake table; anon and authenticated
-- must neither read it nor write it.

revoke all on public.oauth_state from public;
revoke all on public.oauth_state from anon;
revoke all on public.oauth_state from authenticated;

grant select, insert, delete on public.oauth_state to service_role;
