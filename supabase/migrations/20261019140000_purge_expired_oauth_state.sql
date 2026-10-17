-- BOUNDED TTL SWEEP FOR oauth_state.
--
-- WHY IT EXISTS. oauth_state holds one row per in-flight OAuth handshake, consumed by the
-- callback or abandoned when the candidate never returns. Without a sweep, abandoned rows
-- accumulate forever: 20261018120000 indexed expires_at for exactly this purpose but nothing
-- ever used it.
--
-- WHY THIS IS HYGIENE, NOT A SECURITY BOUNDARY. An expired row is already unusable:
-- verifyOAuthState rejects on the SIGNED issuedAt in the payload, not on expires_at, and the
-- consume is a DELETE ... RETURNING keyed on the nonce. Sweeping therefore buys storage and
-- clarity, not protection - which is why it must never be the only thing standing between a
-- replayed callback and a second connection.
--
-- WHY THE GRACE WINDOW IS LOAD-BEARING. expires_at is written from the APPLICATION clock while
-- the sweep compares against the DATABASE clock. If the app runs behind, a bare
-- "expires_at < now()" sweep can delete a row the app would still accept, and a legitimate
-- slow callback is then refused with "This authorization link has already been used." One
-- hour of slack costs nothing (the row is inert either way) and removes that class of
-- self-inflicted lockout.
--
-- WHY THE DELETE IS BOUNDED BY ctid. An unbounded DELETE over a table that has somehow grown
-- large would hold row locks for the length of the scan. The ctid sub-select caps each call at
-- one batch; the next tick collects the rest. Idempotent and safe to run concurrently: two
-- sweeps just divide the rows between them.
--
-- DRIVEN BY THE APP SCHEDULER, NOT pg_cron. Hosted Supabase requires the pg_cron extension to
-- be enabled out-of-band (a privileged dashboard action), which the deploy preflight cannot
-- verify. An invisible control-plane dependency is worse than a task in a scheduler that is
-- already deployed, restarted and logged (server/schedulerTasks.ts, oauth-state-sweep).

create or replace function public.purge_expired_oauth_state(
  grace_interval interval default interval '1 hour'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  purged integer;
begin
  delete from public.oauth_state
  where ctid in (
    select ctid
    from public.oauth_state
    where expires_at < now() - grace_interval
    limit 1000
  );

  get diagnostics purged = row_count;
  return purged;
end;
$$;

comment on function public.purge_expired_oauth_state(interval) is
  'Deletes expired OAuth handshake rows, keeping anything that expired within grace_interval so app/DB clock skew cannot refuse a legitimate slow callback. Returns the number of rows removed; each call is capped at one batch.';

-- Functions are granted EXECUTE to PUBLIC by default, which would expose this maintenance
-- endpoint to anon and authenticated over PostgREST. Revoke that, then grant only the role
-- that actually calls it: the scheduler's service-role client.
revoke all on function public.purge_expired_oauth_state(interval) from PUBLIC;
revoke all on function public.purge_expired_oauth_state(interval) from anon;
revoke all on function public.purge_expired_oauth_state(interval) from authenticated;

grant execute on function public.purge_expired_oauth_state(interval) to service_role;
