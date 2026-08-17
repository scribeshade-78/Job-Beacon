-- Atomic claim-and-lease for application_attempts (R4.3; PRD §16.4
-- worker lifecycle step "Lease one application task atomically"). R4.1's
-- application_attempts migration deliberately left this RPC out ("the
-- worker that uses it is R4.3, not this migration") — this is that R4.3
-- worker's claim function.
--
-- Exact mirror of ingestion_jobs' claim_ingestion_job() (R2): same
-- FOR UPDATE SKIP LOCKED claim query, same 5-minute lease window, same
-- SECURITY INVOKER default (not DEFINER — no reason to run as the
-- function owner, since only service_role, which already bypasses RLS on
-- application_attempts, is granted EXECUTE). Reusing the proven shape
-- instead of inventing a second queuing convention, per the
-- jobbeacon-development skill's guidance to exhaust the minimal
-- Postgres-lease pattern before reaching for anything else.
create function public.claim_application_attempt()
returns setof public.application_attempts
language plpgsql
as $$
declare
  claimed_id uuid;
begin
  select id into claimed_id
  from public.application_attempts
  where (status = 'pending' or (status = 'leased' and leased_until < now()))
    and attempts < max_attempts
  order by created_at
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.application_attempts
  set status = 'leased',
      leased_until = now() + interval '5 minutes',
      attempts = attempts + 1,
      updated_at = now()
  where id = claimed_id;

  return query select * from public.application_attempts where id = claimed_id;
end;
$$;

revoke all on function public.claim_application_attempt() from public;
revoke all on function public.claim_application_attempt() from anon;
revoke all on function public.claim_application_attempt() from authenticated;
grant execute on function public.claim_application_attempt() to service_role;
