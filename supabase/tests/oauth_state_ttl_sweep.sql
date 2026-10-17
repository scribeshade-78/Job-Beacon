begin;
select plan(7);

-- THE PURGE COUNT IS ASSERTED EXACTLY, so the table is emptied inside this transaction first.
-- rollback restores whatever was there before the test ran; a pgTAP test never commits.
delete from public.oauth_state;

create temporary table t_cid as
  select id as cid from public.candidate_profiles limit 1;

-- Three rows, one per zone of the sweep: past the grace window, inside it, and live.
insert into public.oauth_state (nonce, candidate_id, code_verifier, expires_at)
select v.nonce, t.cid, 'verifier', v.expires_at
from t_cid t
cross join (values
  ('sweep-expired', now() - interval '2 hours'),
  ('sweep-grace',   now() - interval '30 minutes'),
  ('sweep-live',    now() + interval '10 minutes')
) as v(nonce, expires_at);

select is(
  public.purge_expired_oauth_state(interval '1 hour'),
  1,
  'sweeps exactly the row that expired beyond the grace window'
);

select is(
  (select count(*)::int from public.oauth_state where nonce = 'sweep-expired'),
  0,
  'the row past the grace window is gone'
);

-- THE GRACE WINDOW IS THE POINT OF THIS ASSERTION. A row that expired 30 minutes ago is
-- unusable, but expires_at came from the app clock while now() is the database clock - so
-- deleting it immediately is how clock skew turns a valid slow callback into a refusal.
select is(
  (select count(*)::int from public.oauth_state where nonce = 'sweep-grace'),
  1,
  'a row inside the grace window survives, so a slow callback is not refused'
);

select is(
  (select count(*)::int from public.oauth_state where nonce = 'sweep-live'),
  1,
  'a live row is untouched'
);

-- SECURITY DEFINER RAISES THE COST OF A GRANT MISTAKE: if EXECUTE leaked to a client role,
-- that role would run this delete with the owner's privileges.
select ok(
  not has_function_privilege('anon', 'public.purge_expired_oauth_state(interval)', 'EXECUTE'),
  'anon cannot execute the sweep'
);

select ok(
  not has_function_privilege('authenticated', 'public.purge_expired_oauth_state(interval)', 'EXECUTE'),
  'authenticated cannot execute the sweep'
);

select ok(
  has_function_privilege('service_role', 'public.purge_expired_oauth_state(interval)', 'EXECUTE'),
  'service_role can execute the sweep, which is how the scheduler calls it'
);

select * from finish();
rollback;
