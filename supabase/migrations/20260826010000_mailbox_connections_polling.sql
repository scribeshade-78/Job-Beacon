-- R6.2: Gmail message polling worker needs atomic per-connection leasing
-- (so two overlapping cron-triggered runs can't double-process the same
-- mailbox) plus failed-connection visibility — same leased_until/last_error
-- shape server/ingestion/worker.ts's ingestion_jobs and
-- server/companies/registryWorker.ts's company_registry_lookup_jobs already
-- use, just embedded directly on mailbox_connections rather than a separate
-- jobs table: "poll this specific connection periodically" doesn't need a
-- per-run row the way an ephemeral ingestion/registry-lookup request does —
-- mailbox_connections IS the one-row-per-work-unit table here.
--
-- poll_failure_count backs the approved 5-strike transient-failure cap:
-- reset to 0 on a successful poll, incremented on a transient failure, and
-- once it reaches 5 the connection's status flips to 'error' (the schema's
-- existing check constraint already allows this value — no constraint
-- change needed) so it drops out of future polling until the candidate
-- reconnects (R6.1's connect flow).
--
-- No RLS/grant changes: RLS is row-level and mailbox_connections_select_own
-- already covers every column for `authenticated`; service_role already has
-- full DML.
alter table public.mailbox_connections
  add column polling_leased_until timestamptz,
  add column last_polled_at timestamptz,
  add column last_poll_error text,
  add column poll_failure_count integer not null default 0;
